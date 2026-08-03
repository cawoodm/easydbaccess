import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from '../../packages/server/src/index.js';
import { createStore } from '../../packages/server/src/storage/factory.js';
import type { StoreAdapter } from '../../packages/server/src/storage/types.js';

/**
 * E2E tests for GET /plugins/registry. Spins up the real Hono app and hits
 * the endpoint via global fetch, exercising the three branches:
 *   - PLUGINS_REGISTRY_PATH unset → empty list + note
 *   - configured + valid file → file contents passthrough
 *   - configured + missing file → empty list + note (not 500)
 */

interface Fixture {
  baseUrl: string;
  store: StoreAdapter;
  tmpRoot: string;
  cleanup: () => Promise<void>;
}

async function startServer(pluginsRegistryPath?: string): Promise<Fixture> {
  const tmpRoot = await mkdtemp(join(tmpdir(), 'easydb-plugins-'));
  const store = createStore('fs', tmpRoot);
  const app = createServer({
    store,
    fetchFn: globalThis.fetch,
    ...(pluginsRegistryPath ? { pluginsRegistryPath } : {}),
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
    tmpRoot,
    cleanup: async () => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close?.();
      await rm(tmpRoot, { recursive: true, force: true });
    },
  };
}

describe('GET /plugins/registry', () => {
  let fx: Fixture;

  afterEach(async () => {
    await fx?.cleanup();
  });

  it('returns empty list with a note when PLUGINS_REGISTRY_PATH is unset', async () => {
    fx = await startServer();
    const res = await fetch(`${fx.baseUrl}/plugins/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: unknown[]; note?: string };
    expect(body.plugins).toEqual([]);
    expect(body.note).toMatch(/not configured/i);
  });

  it('returns the file contents when configured + file is valid', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'easydb-reg-'));
    const path = join(tmpRoot, 'registry.json');
    await writeFile(
      path,
      JSON.stringify({
        plugins: [
          { id: 'a', name: 'Alpha', description: 'first', url: 'https://example.com/a.js' },
          { id: 'b', name: 'Bravo', url: 'https://example.com/b.js' },
        ],
      }),
    );
    fx = await startServer(path);
    try {
      const res = await fetch(`${fx.baseUrl}/plugins/registry`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        plugins: Array<{ id: string; name: string }>;
      };
      expect(body.plugins.map((p) => p.id)).toEqual(['a', 'b']);
      expect(body.plugins[0]?.name).toBe('Alpha');
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('returns empty list with a note when the configured file is missing', async () => {
    fx = await startServer('/no/such/registry.json');
    const res = await fetch(`${fx.baseUrl}/plugins/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: unknown[]; note?: string };
    expect(body.plugins).toEqual([]);
    expect(body.note).toMatch(/not found/i);
  });

  it('rejects with 500 when the configured file is invalid JSON', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'easydb-reg-'));
    const path = join(tmpRoot, 'registry.json');
    await writeFile(path, '{ not valid');
    fx = await startServer(path);
    try {
      const res = await fetch(`${fx.baseUrl}/plugins/registry`);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toMatch(/invalid json/i);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
