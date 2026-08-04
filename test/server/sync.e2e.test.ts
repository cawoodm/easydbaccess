import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from '../../packages/server/src/index.js';
import { createStore, type StoreKind } from '../../packages/server/src/storage/factory.js';
import type { StoreAdapter } from '../../packages/server/src/storage/types.js';

/**
 * E2E tests for the sync API — runs the real Hono app over a real Node HTTP
 * server, hits it via global fetch, exercises both adapters. SSE is verified
 * by reading the streaming body directly.
 */

interface Fixture {
  baseUrl: string;
  store: StoreAdapter;
  storagePath: string;
  cleanup: () => Promise<void>;
}

async function startServer(kind: StoreKind): Promise<Fixture> {
  const tmpRoot = await mkdtemp(join(tmpdir(), `easydb-${kind}-`));
  const storagePath = tmpRoot;
  const store = createStore(kind, storagePath);
  const app = createServer({
    store,
    fetchFn: globalThis.fetch,
    fetchAllowlist: undefined,
    fetchMaxBytes: undefined,
  });

  let httpServer: ServerType;
  const port: number = await new Promise((resolve) => {
    httpServer = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve(info.port);
    });
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    storagePath,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close?.();
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

/** Workspace-dump shape both adapters accept. */
function dump(
  tables: Array<{
    name: string;
    columns: Array<{ field: string; label?: string; type: string }>;
    rows: Array<Record<string, unknown>>;
  }>,
) {
  return { workspaceId: 'unused', exportedAt: 1, tables };
}

const KINDS: StoreKind[] = ['fs', 'sqlite'];

describe.each(KINDS)('sync API (%s)', (kind) => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await startServer(kind);
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('returns 404 for an unwritten workspace', async () => {
    const res = await fetch(`${fx.baseUrl}/sync/ws-alpha`);
    expect(res.status).toBe(404);
  });

  it('PUT without If-Match writes JSON and returns ETag', async () => {
    const payload = dump([
      {
        name: 'People',
        columns: [
          { field: 'name', label: 'Name', type: 'string' },
          { field: 'age', label: 'Age', type: 'number' },
        ],
        rows: [{ name: 'Alice', age: 30 }],
      },
    ]);
    const res = await fetch(`${fx.baseUrl}/sync/ws-alpha`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const etag = stripEtag(res.headers.get('ETag'));
    expect(etag).toMatch(/^[a-f0-9]{40}$/);
    const json = (await res.json()) as { ok: boolean; etag: string };
    expect(json.ok).toBe(true);
    expect(json.etag).toBe(etag);
  });

  it('GET round-trips a multi-column, multi-row table', async () => {
    const payload = dump([
      {
        name: 'People',
        columns: [
          { field: 'name', type: 'string' },
          { field: 'age', type: 'number' },
          { field: 'active', type: 'boolean' },
        ],
        rows: [
          { name: 'Alice', age: 30, active: true },
          { name: 'Bob', age: 25, active: false },
        ],
      },
    ]);
    const putRes = await fetch(`${fx.baseUrl}/sync/ws-bravo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(putRes.status).toBe(200);

    const getRes = await fetch(`${fx.baseUrl}/sync/ws-bravo`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('Content-Type')).toContain('application/json');
    const got = (await getRes.json()) as { tables: typeof payload.tables };
    expect(got.tables).toHaveLength(1);
    expect(got.tables[0]!.name).toBe('People');
    expect(got.tables[0]!.rows).toEqual([
      { name: 'Alice', age: 30, active: true },
      { name: 'Bob', age: 25, active: false },
    ]);
  });

  it('rejects invalid JSON bodies with 400', async () => {
    const res = await fetch(`${fx.baseUrl}/sync/ws-bad`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json-at-all',
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/json/i);
  });

  it('PUT with a stale If-Match returns 412 and the current etag, leaving the store unchanged', async () => {
    const first = dump([{ name: 'T', columns: [{ field: 'v', type: 'string' }], rows: [{ v: 'first' }] }]);
    const second = dump([{ name: 'T', columns: [{ field: 'v', type: 'string' }], rows: [{ v: 'second' }] }]);

    const r1 = await fetch(`${fx.baseUrl}/sync/ws-conflict`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(first),
    });
    const etag1 = stripEtag(r1.headers.get('ETag'))!;

    const r2 = await fetch(`${fx.baseUrl}/sync/ws-conflict`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': '"deadbeef"' },
      body: JSON.stringify(second),
    });
    expect(r2.status).toBe(412);
    const conflict = (await r2.json()) as { conflict: boolean; currentEtag: string };
    expect(conflict.conflict).toBe(true);
    expect(conflict.currentEtag).toBe(etag1);

    const r3 = await fetch(`${fx.baseUrl}/sync/ws-conflict`);
    expect(stripEtag(r3.headers.get('ETag'))).toBe(etag1);
    const body3 = (await r3.json()) as { tables: typeof first.tables };
    expect(body3.tables[0]!.rows).toEqual([{ v: 'first' }]);
  });

  it('PUT with the current If-Match succeeds and rotates the etag', async () => {
    const first = dump([{ name: 'T', columns: [{ field: 'v', type: 'number' }], rows: [{ v: 1 }] }]);
    const second = dump([{ name: 'T', columns: [{ field: 'v', type: 'number' }], rows: [{ v: 2 }] }]);

    const r1 = await fetch(`${fx.baseUrl}/sync/ws-rotate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(first),
    });
    const etag1 = stripEtag(r1.headers.get('ETag'))!;

    const r2 = await fetch(`${fx.baseUrl}/sync/ws-rotate`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${etag1}"` },
      body: JSON.stringify(second),
    });
    expect(r2.status).toBe(200);
    const etag2 = stripEtag(r2.headers.get('ETag'))!;
    expect(etag2).not.toBe(etag1);

    const r3 = await fetch(`${fx.baseUrl}/sync/ws-rotate`);
    expect(stripEtag(r3.headers.get('ETag'))).toBe(etag2);
    const body3 = (await r3.json()) as { tables: typeof first.tables };
    expect(body3.tables[0]!.rows).toEqual([{ v: 2 }]);
  });

  it('GET /sync lists known workspaces', async () => {
    const payload = dump([{ name: 'T', columns: [{ field: 'v', type: 'string' }], rows: [] }]);
    await fetch(`${fx.baseUrl}/sync/ws-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    await fetch(`${fx.baseUrl}/sync/ws-2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const res = await fetch(`${fx.baseUrl}/sync`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { workspaces: string[] };
    expect(new Set(json.workspaces)).toEqual(new Set(['ws-1', 'ws-2']));
  });

  it('rejects workspace IDs with path-traversal characters', async () => {
    const res = await fetch(`${fx.baseUrl}/sync/..%2Fetc%2Fpasswd`);
    expect(res.status).toBe(400);
  });

  it('SSE stream emits an initial event and then a change event on next PUT', async () => {
    const payload = dump([{ name: 'T', columns: [{ field: 'v', type: 'string' }], rows: [{ v: 'seed' }] }]);
    await fetch(`${fx.baseUrl}/sync/ws-sse`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const ac = new AbortController();
    const streamRes = await fetch(`${fx.baseUrl}/sync/ws-sse/stream`, { signal: ac.signal });
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toContain('text/event-stream');

    const reader = streamRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';

    async function nextFrame(): Promise<{ event: string; data: string }> {
      while (true) {
        const idx = buffered.indexOf('\n\n');
        if (idx >= 0) {
          const raw = buffered.slice(0, idx);
          buffered = buffered.slice(idx + 2);
          const event = /event:\s*(.*)/.exec(raw)?.[1]?.trim() ?? 'message';
          const data = /data:\s*(.*)/.exec(raw)?.[1]?.trim() ?? '';
          return { event, data };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream closed before frame');
        buffered += decoder.decode(value, { stream: true });
      }
    }

    const initial = await nextFrame();
    expect(initial.event).toBe('init');
    const initialData = JSON.parse(initial.data) as { etag: string | null };
    expect(initialData.etag).toMatch(/^[a-f0-9]{40}$/);

    const bumped = dump([{ name: 'T', columns: [{ field: 'v', type: 'string' }], rows: [{ v: 'updated' }] }]);
    await fetch(`${fx.baseUrl}/sync/ws-sse`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bumped),
    });

    const change = await nextFrame();
    expect(change.event).toBe('change');
    const changeData = JSON.parse(change.data) as { etag: string };
    expect(changeData.etag).toMatch(/^[a-f0-9]{40}$/);
    expect(changeData.etag).not.toBe(initialData.etag);

    ac.abort();
    await reader.cancel().catch(() => {});
  });
});

// -- SQLite-specific structural assertions -----------------------------------

const sqliteRequire = createRequire(import.meta.url);
const { DatabaseSync } = sqliteRequire('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
    close(): void;
  };
};

describe('sqlite adapter — structural', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await startServer('sqlite');
  });

  afterEach(async () => {
    await fx.cleanup();
  });

  it('rejects bodies that are not workspace dumps with a 400 and helpful error', async () => {
    const res = await fetch(`${fx.baseUrl}/sync/ws-malformed`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ random: 'object' }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error.toLowerCase()).toContain('tables');
  });

  it('rejects duplicate column fields with a 400', async () => {
    const res = await fetch(`${fx.baseUrl}/sync/ws-dup`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        dump([
          {
            name: 'T',
            columns: [
              { field: 'x', type: 'string' },
              { field: 'x', type: 'number' },
            ],
            rows: [],
          },
        ]),
      ),
    });
    expect(res.status).toBe(400);
  });

  it('materialises one SQL table per workspace table with the right affinities', async () => {
    const payload = dump([
      {
        name: 'People',
        columns: [
          { field: 'name', type: 'string' },
          { field: 'age', type: 'number' },
          { field: 'active', type: 'boolean' },
          { field: 'joined', type: 'date' },
          { field: 'avatar', type: 'string' },
        ],
        rows: [
          { name: 'Alice', age: 30, active: true, joined: '2026-01-01', avatar: 'x.png' },
          { name: 'Bob', age: 25, active: false, joined: '2026-02-02', avatar: 'y.png' },
        ],
      },
      {
        name: 'Notes',
        columns: [{ field: 'body', type: 'string' }],
        rows: [{ body: 'hello' }],
      },
    ]);
    const putRes = await fetch(`${fx.baseUrl}/sync/ws-shape`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(putRes.status).toBe(200);

    // Open the file from a second connection and inspect via sqlite_master /
    // PRAGMA — proves the adapter built real SQL, not just a JSON column.
    const reader = new DatabaseSync(join(fx.storagePath, 'ws-shape.db'));
    try {
      const tables = reader.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);

      expect(names).toContain('_easydb_meta');
      expect(names).toContain('_easydb_tables');
      expect(names).toContain('People');
      expect(names).toContain('Notes');

      const peopleCols = reader.prepare(`PRAGMA table_info("People")`).all() as Array<{
        name: string;
        type: string;
      }>;
      const byName = new Map(peopleCols.map((c) => [c.name, c.type.toUpperCase()]));
      expect(byName.get('_id')).toBe('INTEGER');
      expect(byName.get('name')).toBe('TEXT');
      expect(byName.get('age')).toBe('REAL');
      expect(byName.get('active')).toBe('INTEGER');
      expect(byName.get('joined')).toBe('TEXT');
      expect(byName.get('avatar')).toBe('TEXT');

      // Booleans stored as 0/1, query directly to confirm.
      const aliceActive = reader.prepare(`SELECT active FROM "People" WHERE name = ?`).get('Alice') as { active: number };
      expect(aliceActive.active).toBe(1);
      const bobActive = reader.prepare(`SELECT active FROM "People" WHERE name = ?`).get('Bob') as { active: number };
      expect(bobActive.active).toBe(0);

      // Numbers stored as REAL.
      const aliceAge = reader.prepare(`SELECT age FROM "People" WHERE name = ?`).get('Alice') as { age: number };
      expect(aliceAge.age).toBe(30);
    } finally {
      reader.close();
    }

    // And pull through the API still round-trips booleans as JS booleans.
    const getRes = await fetch(`${fx.baseUrl}/sync/ws-shape`);
    const got = (await getRes.json()) as {
      tables: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
    };
    const people = got.tables.find((t) => t.name === 'People')!;
    expect(people.rows[0]!.active).toBe(true);
    expect(people.rows[1]!.active).toBe(false);
  });

  it('a second push clobbers the previous SQL tables', async () => {
    const first = dump([
      {
        name: 'Old',
        columns: [{ field: 'x', type: 'string' }],
        rows: [{ x: 'gone' }],
      },
    ]);
    const second = dump([
      {
        name: 'New',
        columns: [{ field: 'y', type: 'number' }],
        rows: [{ y: 42 }],
      },
    ]);

    await fetch(`${fx.baseUrl}/sync/ws-clobber`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(first),
    });
    await fetch(`${fx.baseUrl}/sync/ws-clobber`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(second),
    });

    const reader = new DatabaseSync(join(fx.storagePath, 'ws-clobber.db'));
    try {
      const tables = reader.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_easydb_%' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).toEqual(['New']);
    } finally {
      reader.close();
    }

    const getRes = await fetch(`${fx.baseUrl}/sync/ws-clobber`);
    const got = (await getRes.json()) as {
      tables: Array<{ name: string; rows: Array<Record<string, unknown>> }>;
    };
    expect(got.tables.map((t) => t.name)).toEqual(['New']);
    expect(got.tables[0]!.rows).toEqual([{ y: 42 }]);
  });
});

function stripEtag(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}
