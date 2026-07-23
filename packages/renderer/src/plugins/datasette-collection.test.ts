import { describe, expect, it } from 'vitest';
import type { DataCollection, RowSourceCtx, Setting, Table } from '@easydb/shared';
import { createDatasetteCollection, SourceReadOnlyError, tokenSettingKey } from './datasette-collection.js';

/** A fake RowSourceCtx that records fetch calls + emitted events. */
function makeCtx(responder: (call: { url: string; opts: any }) => unknown) {
  const calls: Array<{ url: string; opts: any }> = [];
  const events: Array<{ name: string; payload: unknown }> = [];
  const store = new Map<string, unknown>();

  const settings = {
    async findOne(key: string) {
      return store.has(key) ? ({ key, value: store.get(key) } as Setting) : null;
    },
  } as unknown as DataCollection<Setting>;

  const ctx = {
    backend: {
      fetch: (url: string, opts?: any) => {
        calls.push({ url, opts });
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(responder({ url, opts })),
        } as unknown as Response);
      },
      saveFile: async () => undefined,
    },
    events: {
      on: () => () => undefined,
      emit: (name: string, payload: unknown) => events.push({ name, payload }),
    },
    settings,
    workspaceId: () => 'ws',
  } as unknown as RowSourceCtx;

  return { ctx, calls, events, setToken: (base: string, tok: string) => store.set(tokenSettingKey(base), tok) };
}

const BASE = 'https://x.datasette.io';
function sourcedTable(writable: boolean): Table {
  return {
    id: 't1',
    workspaceId: 'ws',
    name: 'db/t',
    code: 'db-t',
    columns: [],
    view: 'table',
    updatedAt: 0,
    source: { type: 'datasette', writable, config: { base: BASE, db: 'db', table: 't', pks: ['id'] } },
  };
}

const upd = (calls: Array<{ url: string; opts: any }>) => calls.find((c) => c.url.includes('/-/'))!;

describe('createDatasetteCollection — read', () => {
  it('maps rows to Row records keyed by the tilde-encoded primary key', async () => {
    const { ctx } = makeCtx(() => ({ ok: true, next: null, rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }] }));
    const coll = createDatasetteCollection(sourcedTable(false), ctx);
    const rows = await coll.find();
    expect(rows.map((r) => r.id)).toEqual(['1', '2']);
    expect(rows[0]!.tableId).toBe('t1');
    expect(rows[0]!.data).toEqual({ id: 1, name: 'a' });
  });
});

describe('createDatasetteCollection — request dedup', () => {
  const rowReqs = (calls: Array<{ url: string }>) =>
    calls.filter((c) => c.url.includes('/db/t.json')).length;

  it('subscribe + find on one instance issue a single row request', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true, next: null, rows: [{ id: 1, name: 'a' }] }));
    const coll = createDatasetteCollection(sourcedTable(false), ctx);
    // The grid does exactly this on mount: subscribe, then find.
    const seen: number[] = [];
    coll.subscribe((r) => seen.push(r.length));
    const rows = await coll.find();
    // one network round-trip shared by both, not one each
    expect(rowReqs(calls)).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it('a second find() after load serves the cache without refetching', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true, next: null, rows: [{ id: 1, name: 'a' }] }));
    const coll = createDatasetteCollection(sourcedTable(false), ctx);
    await coll.find();
    await coll.find();
    await coll.findOne('1');
    expect(rowReqs(calls)).toBe(1);
  });
});

describe('createDatasetteCollection — read-only guard', () => {
  const ro = () => createDatasetteCollection(sourcedTable(false), makeCtx(() => ({ ok: true, rows: [] })).ctx);

  it('throws SourceReadOnlyError for insert/patch/remove when not writable', async () => {
    await expect(ro().insert({ id: '1', tableId: 't1', data: { name: 'a' }, updatedAt: 0 })).rejects.toBeInstanceOf(
      SourceReadOnlyError,
    );
    await expect(ro().patch('1', { data: { name: 'b' } })).rejects.toBeInstanceOf(SourceReadOnlyError);
    await expect(ro().remove('1')).rejects.toThrow(/read-only/);
  });
});

describe('createDatasetteCollection — writes', () => {
  it('patch sends changed fields (minus PK) to /<pk>/-/update with the token', async () => {
    const { ctx, calls, events, setToken } = makeCtx(({ url }) =>
      url.includes('/-/update') ? { ok: true, rows: [{ id: 5, name: 'b', qty: 99 }] } : { ok: true, next: null, rows: [] },
    );
    setToken(BASE, 'dstok_ABC');
    const coll = createDatasetteCollection(sourcedTable(true), ctx);

    const row = await coll.patch('5', { data: { id: 5, name: 'b', qty: 99 } });

    const call = upd(calls);
    expect(call.url).toBe('https://x.datasette.io/db/t/5/-/update');
    expect(call.opts.headers.Authorization).toBe('Bearer dstok_ABC');
    expect(JSON.parse(call.opts.body)).toEqual({ update: { name: 'b', qty: 99 }, return: true }); // id (pk) stripped
    expect(row.id).toBe('5');
    expect(row.data).toEqual({ id: 5, name: 'b', qty: 99 });
    expect(events.some((e) => e.name === 'row:updated')).toBe(true);
  });

  it('insert posts the row (no synthetic id) and keys the result by the returned PK', async () => {
    const { ctx, calls, events } = makeCtx(({ url }) =>
      url.endsWith('/-/insert') ? { ok: true, rows: [{ id: 9, name: 'z' }] } : { ok: true, next: null, rows: [] },
    );
    const coll = createDatasetteCollection(sourcedTable(true), ctx);

    const row = await coll.insert({ id: 'tmp', tableId: 't1', data: { name: 'z' }, updatedAt: 0 });

    const call = calls.find((c) => c.url.endsWith('/-/insert'))!;
    expect(JSON.parse(call.opts.body)).toEqual({ rows: [{ name: 'z' }], return: true });
    expect(row.id).toBe('9'); // from the server's returned row, not 'tmp'
    expect(events.some((e) => e.name === 'row:created')).toBe(true);
  });

  it('remove deletes by PK and emits row:deleted', async () => {
    const { ctx, calls, events } = makeCtx(() => ({ ok: true, next: null, rows: [] }));
    const coll = createDatasetteCollection(sourcedTable(true), ctx);

    await coll.remove('7');

    const call = calls.find((c) => c.url.endsWith('/7/-/delete'))!;
    expect(call.opts.method).toBe('POST');
    expect(JSON.parse(call.opts.body)).toEqual({});
    expect(events.some((e) => e.name === 'row:deleted')).toBe(true);
  });

  it('sends no Authorization header when no device-local token is stored', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true, next: null, rows: [] }));
    const coll = createDatasetteCollection(sourcedTable(true), ctx);
    await coll.remove('1');
    const call = calls.find((c) => c.url.endsWith('/1/-/delete'))!;
    expect(call.opts.headers.Authorization).toBeUndefined();
  });
});

describe('createDatasetteCollection — authenticated reads (private instances)', () => {
  it('sends the device-local token on read requests', async () => {
    const { ctx, calls, setToken } = makeCtx(() => ({ ok: true, next: null, rows: [{ id: 1, name: 'a' }] }));
    setToken(BASE, 'dstok_R');
    const coll = createDatasetteCollection(sourcedTable(false), ctx); // reads work even read-only
    await coll.find();
    const read = calls.find((c) => c.url.includes('/db/t.json'))!;
    expect(read.opts?.headers?.Authorization).toBe('Bearer dstok_R');
  });

  it('sends no auth header on reads when no token is stored', async () => {
    const { ctx, calls } = makeCtx(() => ({ ok: true, next: null, rows: [] }));
    const coll = createDatasetteCollection(sourcedTable(false), ctx);
    await coll.find();
    const read = calls.find((c) => c.url.includes('/db/t.json'))!;
    expect(read.opts?.headers?.Authorization).toBeUndefined();
  });
});
