import { describe, expect, it, vi } from 'vitest';
import type { PluginRecord, Row, Table, Workspace } from '@easydb/shared';
import { createIpcDataStore, type EasydbStoreBridge } from '../../../packages/renderer/src/db/data-store-ipc.js';

/* `fakeBridge`'s methods are async only to match the real IPC bridge's shape —
   an in-memory Map needs nothing awaited. */
/* eslint-disable require-await */

/**
 * An in-memory stand-in for `window.easydb.store`. Mirrors
 * `SqliteStore`'s document semantics (whole-doc JSON, promoted-column
 * equality filtering, `patch` = merge+persist+return) closely enough to
 * drive the adapter without Electron. `onChanged` listeners are called
 * synchronously by `broadcast()`, same as the real bridge fires
 * `store:changed` once its own write is done.
 */
function fakeBridge(): EasydbStoreBridge & { broadcast(coll: string, scope?: string): void } {
  const docs = new Map<string, Map<string, Record<string, unknown>>>();
  const listeners = new Set<(coll: string, scope?: string) => void>();

  const collOf = (coll: string): Map<string, Record<string, unknown>> => {
    let m = docs.get(coll);
    if (!m) {
      m = new Map();
      docs.set(coll, m);
    }
    return m;
  };
  const keyField = (coll: string): string => (coll === 'plugins' ? 'url' : coll === 'settings' ? 'key' : 'id');
  const keyOf = (coll: string, doc: Record<string, unknown>): string => String(doc[keyField(coll)]);

  return {
    async find(coll, query) {
      const all = [...collOf(coll).values()];
      if (!query || Object.keys(query).length === 0) return all;
      const entries = Object.entries(query);
      return all.filter((doc) => entries.every(([k, v]) => doc[k] === v));
    },
    async findOne(coll, key) {
      return collOf(coll).get(key) ?? null;
    },
    // Mirrors `SqliteStore.countRowsIn`: one table's rows, none of them read.
    async countRows(tableId) {
      return [...collOf('rows').values()].filter((d) => d.tableId === tableId).length;
    },
    async insert(coll, doc) {
      collOf(coll).set(keyOf(coll, doc), doc);
      return doc;
    },
    async bulkInsert(coll, docsIn) {
      for (const d of docsIn) collOf(coll).set(keyOf(coll, d), d);
      return docsIn;
    },
    async upsert(coll, doc) {
      collOf(coll).set(keyOf(coll, doc), doc);
      return doc;
    },
    async patch(coll, key, patch) {
      const existing = collOf(coll).get(key);
      if (!existing) throw new Error(`fakeBridge.patch: no doc in "${coll}" with key "${key}"`);
      const merged = { ...existing, ...patch };
      collOf(coll).set(key, merged);
      return merged;
    },
    async remove(coll, key) {
      collOf(coll).delete(key);
    },
    async bulkRemove(coll, keys) {
      for (const k of keys) collOf(coll).delete(k);
    },
    async count(coll) {
      return collOf(coll).size;
    },
    onChanged(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async dbPath() {
      return ':memory:';
    },
    broadcast(coll: string, scope?: string) {
      for (const l of [...listeners]) l(coll, scope);
    },
  };
}

function row(id: string, tableId: string, data: Record<string, unknown> = {}): Row {
  return { id, tableId, data, updatedAt: 0 };
}

describe('createIpcDataStore', () => {
  it('maps each DataCollection method to the matching bridge call', async () => {
    const bridge = fakeBridge();
    const findSpy = vi.spyOn(bridge, 'find');
    const findOneSpy = vi.spyOn(bridge, 'findOne');
    const insertSpy = vi.spyOn(bridge, 'insert');
    const bulkInsertSpy = vi.spyOn(bridge, 'bulkInsert');
    const upsertSpy = vi.spyOn(bridge, 'upsert');
    const patchSpy = vi.spyOn(bridge, 'patch');
    const removeSpy = vi.spyOn(bridge, 'remove');
    const bulkRemoveSpy = vi.spyOn(bridge, 'bulkRemove');
    const store = createIpcDataStore(bridge, () => 'ws1');

    const w: Workspace = { id: 'w1', name: 'W1', createdAt: 0, pluginUrls: [] };
    await store.workspaces.insert(w);
    expect(insertSpy).toHaveBeenCalledWith('workspaces', w);

    await store.workspaces.find({ name: 'W1' });
    expect(findSpy).toHaveBeenCalledWith('workspaces', { name: 'W1' });

    await store.workspaces.findOne('w1');
    expect(findOneSpy).toHaveBeenCalledWith('workspaces', 'w1');

    await store.workspaces.upsert(w);
    expect(upsertSpy).toHaveBeenCalledWith('workspaces', w);

    await store.workspaces.patch('w1', { name: 'Renamed' });
    expect(patchSpy).toHaveBeenCalledWith('workspaces', 'w1', { name: 'Renamed' });

    const w2: Workspace = { id: 'w2', name: 'W2', createdAt: 0, pluginUrls: [] };
    await store.workspaces.bulkInsert([w2]);
    expect(bulkInsertSpy).toHaveBeenCalledWith('workspaces', [w2]);

    await store.workspaces.remove('w2');
    expect(removeSpy).toHaveBeenCalledWith('workspaces', 'w2');

    await store.workspaces.bulkRemove(['w1']);
    expect(bulkRemoveSpy).toHaveBeenCalledWith('workspaces', ['w1']);
  });

  it('bulkInsert/bulkRemove skip the round trip entirely for an empty array', async () => {
    const bridge = fakeBridge();
    const bulkInsertSpy = vi.spyOn(bridge, 'bulkInsert');
    const bulkRemoveSpy = vi.spyOn(bridge, 'bulkRemove');
    const store = createIpcDataStore(bridge, () => 'ws1');

    expect(await store.tables.bulkInsert([])).toEqual([]);
    await store.tables.bulkRemove([]);

    expect(bulkInsertSpy).not.toHaveBeenCalled();
    expect(bulkRemoveSpy).not.toHaveBeenCalled();
  });

  it('rows(tableId) auto-injects tableId on insert/bulkInsert and filters reads', async () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');

    const r1 = await store.rows('t1').insert(row('r1', 'ignored-on-write'));
    expect(r1.tableId).toBe('t1'); // stamped, not the caller's value

    await store.rows('t1').bulkInsert([row('r2', 'ignored'), row('r3', 'ignored')]);
    await store.rows('t2').insert(row('r4', 'ignored'));

    const t1Rows = await store.rows('t1').find();
    expect(t1Rows.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);

    const t2Rows = await store.rows('t2').find();
    expect(t2Rows.map((r) => r.id)).toEqual(['r4']);

    // findOne only returns a hit that belongs to THIS table's view.
    expect(await store.rows('t1').findOne('r4')).toBeNull();
    expect(await store.rows('t2').findOne('r4')).not.toBeNull();
  });

  it('settings is workspace-scoped like the Dexie version', async () => {
    const bridge = fakeBridge();
    const storeA = createIpcDataStore(bridge, () => 'wsA');
    const storeB = createIpcDataStore(bridge, () => 'wsB');

    await storeA.settings.upsert({ name: 'token', value: 'a-value' });
    await storeB.settings.upsert({ name: 'token', value: 'b-value' });

    expect((await storeA.settings.findOne('token'))?.value).toBe('a-value');
    expect((await storeB.settings.findOne('token'))?.value).toBe('b-value');

    const allA = await storeA.settings.find();
    expect(allA).toHaveLength(1);
    expect(allA[0]?.value).toBe('a-value');

    // Physical key carries the workspace id, same scheme as data-store-dexie.ts.
    expect(await bridge.findOne('settings', 'wsA::token')).not.toBeNull();
    expect(await bridge.findOne('settings', 'wsB::token')).not.toBeNull();
  });

  it('subscribe emits an initial value and re-emits only for its own collection', async () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    await store.tables.insert({
      id: 't1',
      workspaceId: 'ws1',
      name: 'T1',
      code: 'T1',
      columns: [],
      view: 'table',
      updatedAt: 0,
    } as Table);

    const seen: Table[][] = [];
    const unsubscribe = store.tables.subscribe((docs) => seen.push(docs));
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);

    bridge.broadcast('rows'); // a different collection — must not re-emit
    await flush();
    expect(seen).toHaveLength(1);

    bridge.broadcast('tables');
    await flush();
    expect(seen).toHaveLength(2);

    unsubscribe();
    bridge.broadcast('tables');
    await flush();
    expect(seen).toHaveLength(2); // nothing further after unsubscribe
  });

  it("a rows(tableId) subscription only re-emits for its own tableId's contents", async () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    await store.rows('t1').insert(row('r1', 't1'));
    await store.rows('t2').insert(row('r2', 't2'));

    const seenT1: Row[][] = [];
    store.rows('t1').subscribe((docs) => seenT1.push(docs));
    await flush();
    expect(seenT1[0]?.map((r) => r.id)).toEqual(['r1']);

    // A write to a DIFFERENT table still broadcasts the coarse 'rows' event
    // (the bridge can't tell tables apart) — the re-run must still only
    // return t1's own rows, never t2's.
    await store.rows('t2').insert(row('r3', 't2'));
    bridge.broadcast('rows');
    await flush();
    expect(seenT1.at(-1)?.map((r) => r.id)).toEqual(['r1']);
  });

  /**
   * An import fills one table at a time and broadcasts per table. Without a
   * scope, each of those broadcasts re-read EVERY open table's rows — quadratic,
   * and ruinous when one of them holds 609k rows. A scoped broadcast is for the
   * named table only; an unscoped one still reaches everybody.
   */
  it('a row broadcast scoped to one table leaves the other tables alone', async () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    await store.rows('t1').insert(row('r1', 't1'));
    await store.rows('t2').insert(row('r2', 't2'));

    const runsT1: number[] = [];
    const runsT2: number[] = [];
    store.rows('t1').subscribe((docs) => runsT1.push(docs.length));
    store.rows('t2').subscribe((docs) => runsT2.push(docs.length));
    await flush();
    expect(runsT1).toHaveLength(1);
    expect(runsT2).toHaveLength(1);

    bridge.broadcast('rows', 't1');
    await flush();
    expect(runsT1).toHaveLength(2);
    expect(runsT2).toHaveLength(1); // untouched — this is the whole point

    // No scope means "something changed, everyone re-read", as every ordinary
    // write does.
    bridge.broadcast('rows');
    await flush();
    expect(runsT1).toHaveLength(3);
    expect(runsT2).toHaveLength(2);
  });

  it('delivers the newest state even when an earlier re-run resolves later (out-of-order IPC)', async () => {
    const bridge = fakeBridge();
    // Wrap `find` so the FIRST call is slow and the SECOND is fast, letting the
    // second's resolution land before the first's — exactly the race a burst
    // of writes over real IPC could produce.
    let call = 0;
    const originalFind = bridge.find.bind(bridge);
    vi.spyOn(bridge, 'find').mockImplementation(async (coll, query) => {
      call += 1;
      if (call === 1) {
        await new Promise((r) => setTimeout(r, 30)); // slow: the initial subscribe read
      } else if (call === 2) {
        await new Promise((r) => setTimeout(r, 0)); // fast: the re-run after the write
      }
      return originalFind(coll, query);
    });

    const store = createIpcDataStore(bridge, () => 'ws1');
    const seen: PluginRecord[][] = [];
    store.plugins.subscribe((docs) => seen.push(docs));

    // Fired while the slow initial read (call 1) is still in flight — its
    // re-run is call 2, which resolves first.
    await store.plugins.insert({ url: 'p1', enabled: true, lastFetched: 0 });
    bridge.broadcast('plugins');

    await new Promise((r) => setTimeout(r, 60)); // let both calls settle

    // Only ONE emission ever reaches the subscriber: call 1's late result is
    // superseded by call 2 before it resolves, so it's discarded rather than
    // delivered after (and overwriting) the newer state.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((p) => p.url)).toEqual(['p1']);
  });
});

/** Lets already-queued microtasks (the adapter's `.then` chains) settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * `watch` is the change signal WITHOUT the rows.
 *
 * `subscribe` has to read the collection to have something to hand its callback,
 * so a consumer that runs its own narrow query paid for every row on every write
 * — and `data-table` paid it twice on open. What matters here is not just that
 * the callback fires, but that NOTHING was read to make it fire.
 */
describe('rows().watch', () => {
  it('notifies without reading a single row', () => {
    const bridge = fakeBridge();
    const spy = vi.spyOn(bridge, 'find');
    const store = createIpcDataStore(bridge, () => 'ws1');
    const seen: number[] = [];

    const off = store.rows('t1').watch!(() => seen.push(seen.length));
    expect(seen).toHaveLength(1); // fires once immediately, like subscribe
    bridge.broadcast('rows');
    expect(seen).toHaveLength(2);
    // The whole point: no fetch happened for any of it.
    expect(spy).not.toHaveBeenCalled();
    off();
  });

  it('ignores a broadcast for another collection', () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    let calls = 0;
    const off = store.rows('t1').watch!(() => calls++);
    calls = 0;
    bridge.broadcast('tables');
    bridge.broadcast('settings');
    expect(calls).toBe(0);
    off();
  });

  it('sits out a broadcast scoped to a DIFFERENT table', () => {
    // An import fills one table at a time and scopes its broadcast to it. Without
    // this, filling one table made every other open grid re-query — the quadratic
    // work that dominated a 13-table import.
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    let mine = 0;
    const off = store.rows('t1').watch!(() => mine++);
    mine = 0;
    bridge.broadcast('rows', 't2');
    expect(mine).toBe(0);
    bridge.broadcast('rows', 't1');
    expect(mine).toBe(1);
    off();
  });

  it('still hears an UNSCOPED rows write, which is what an ordinary edit is', () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    let mine = 0;
    const off = store.rows('t1').watch!(() => mine++);
    mine = 0;
    bridge.broadcast('rows');
    expect(mine).toBe(1);
    off();
  });

  it('stops notifying once unsubscribed', () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    let calls = 0;
    const off = store.rows('t1').watch!(() => calls++);
    off();
    calls = 0;
    bridge.broadcast('rows');
    expect(calls).toBe(0);
  });
});

/**
 * `count` is the TABLE's row count, which is not the same number as how many a
 * filter matched (`QueryPage.total`). The panel title needs both, and once the
 * grid stopped fetching everything it could no longer derive this one.
 */
describe('rows().count', () => {
  it('counts without reading a row', async () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    const spy = vi.spyOn(bridge, 'find');
    const n = await store.rows('t1').count!();
    expect(n).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('counts only this table, not every table sharing the collection', async () => {
    const bridge = fakeBridge();
    const store = createIpcDataStore(bridge, () => 'ws1');
    await store.rows('t1').bulkInsert([
      { id: 'a', tableId: 't1', data: {}, updatedAt: 1 },
      { id: 'b', tableId: 't1', data: {}, updatedAt: 1 },
    ] as Row[]);
    await store.rows('t2').insert({ id: 'c', tableId: 't2', data: {}, updatedAt: 1 } as Row);
    expect(await store.rows('t1').count!()).toBe(2);
    expect(await store.rows('t2').count!()).toBe(1);
  });
});
