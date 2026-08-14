import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PluginRecord, Row, Setting, Table, ViewInstance, ViewTemplate, Workspace } from '../../../packages/shared/src/types.js';
import type { DataStore } from '../../../packages/shared/src/plugin-api.js';
import { EdbStore } from '../../../packages/shared/src/edb-store.js';
import { createIpcDataStore, type EasydbStoreBridge } from '../../../packages/renderer/src/db/data-store-bridge.js';
import { copyWorkspace } from '../../../packages/renderer/src/db/edb/convert.js';
import { nodeSqliteDriver } from '../../shared/node-sqlite-driver.js';

/**
 * Converting a workspace into a `.edb` file.
 *
 * The target is the real store the browser worker runs, over a real SQLite. Only
 * the source is a fake, because what matters is that `copyWorkspace` talks to
 * both sides through the plain `DataStore` contract and nothing else.
 */

const WS = 'w1';

const LOCAL: Table = {
  id: 't1',
  workspaceId: WS,
  name: 'Parts',
  code: 'parts',
  columns: [
    { field: 'name', label: 'Name', type: 'string' },
    { field: 'qty', label: 'Qty', type: 'number' },
  ],
  view: 'table',
  updatedAt: 1,
} as Table;

/** A table whose rows a provider owns. Its definition travels, its rows do not. */
const REMOTE: Table = {
  ...LOCAL,
  id: 't2',
  name: 'Live',
  code: 'live',
  source: { type: 'datasette', url: 'https://example.invalid/db' },
} as unknown as Table;

const ROWS: Row[] = [
  { id: 'r1', tableId: 't1', data: { name: 'bolt', qty: 4 }, updatedAt: 5 },
  { id: 'r2', tableId: 't1', data: { name: 'nut', qty: 9, note: 'spare' }, updatedAt: 6 },
];

/** Read-only collection over a fixed array. Only what `copyWorkspace` reads. */
function readOnly<T extends Record<string, unknown>>(docs: T[], idKey: string): Record<string, unknown> {
  return {
    find: async (query?: Partial<T>) => docs.filter((d) => Object.entries(query ?? {}).every(([k, v]) => d[k] === v)),
    findOne: async (id: string) => docs.find((d) => d[idKey] === id) ?? null,
    // The source is never written to. A call here is a bug worth failing on.
    insert: () => Promise.reject(new Error('the source must not be written')),
    bulkInsert: () => Promise.reject(new Error('the source must not be written')),
    upsert: () => Promise.reject(new Error('the source must not be written')),
    patch: () => Promise.reject(new Error('the source must not be written')),
    remove: () => Promise.reject(new Error('the source must not be written')),
    bulkRemove: () => Promise.reject(new Error('the source must not be written')),
    subscribe: () => () => {},
  };
}

function fakeSource(): DataStore {
  const workspaces: Workspace[] = [{ id: WS, name: 'work', createdAt: 1, pluginUrls: ['https://example.invalid/p.js'] }];
  const settings: Setting[] = [
    { name: 'theme', value: 'dark' },
    { name: 'rows', value: 42 },
  ];
  const plugins: PluginRecord[] = [{ url: 'https://example.invalid/p.js', enabled: true, lastFetched: 3 }];
  const templates: ViewTemplate[] = [{ id: 'vt1', workspaceId: WS, name: 'cards', headerHtml: '', rowHtml: '<b>$NAME</b>', footerHtml: '', updatedAt: 2 }];
  const instances: ViewInstance[] = [{ id: 'vi1', workspaceId: WS, tableId: 't1', templateId: 'vt1', open: false } as unknown as ViewInstance];
  const rowsByTable: Record<string, Row[]> = { t1: ROWS, t2: [] };
  return {
    workspaces: readOnly(workspaces as unknown as Record<string, unknown>[], 'id'),
    tables: readOnly([LOCAL, REMOTE] as unknown as Record<string, unknown>[], 'id'),
    settings: readOnly(settings as unknown as Record<string, unknown>[], 'name'),
    plugins: readOnly(plugins as unknown as Record<string, unknown>[], 'url'),
    viewTemplates: readOnly(templates as unknown as Record<string, unknown>[], 'id'),
    viewInstances: readOnly(instances as unknown as Record<string, unknown>[], 'id'),
    rows: (tableId: string) => readOnly((rowsByTable[tableId] ?? []) as unknown as Record<string, unknown>[], 'id'),
  } as unknown as DataStore;
}

/** `EdbStore` as the async bridge `createIpcDataStore` expects. */
function bridgeOver(store: EdbStore): EasydbStoreBridge {
  return {
    find: async (coll, query) => store.find(coll, query),
    findOne: async (coll, key) => store.findOne(coll, key),
    insert: async (coll, doc) => store.insert(coll, doc),
    bulkInsert: async (coll, docs) => store.bulkInsert(coll, docs),
    upsert: async (coll, doc) => store.upsert(coll, doc),
    patch: async (coll, key, patch) => store.patch(coll, key, patch),
    remove: async (coll, key) => void store.remove(coll, key),
    bulkRemove: async (coll, keys) => void store.bulkRemove(coll, keys),
    count: async (coll) => store.count(coll),
    onChanged: () => () => {},
    dbPath: async () => 'test.edb',
  };
}

let driver: ReturnType<typeof nodeSqliteDriver>;
let edb: EdbStore;
let target: DataStore;

beforeEach(() => {
  driver = nodeSqliteDriver();
  edb = new EdbStore(driver);
  target = createIpcDataStore(bridgeOver(edb), () => WS);
});

afterEach(() => {
  driver.close();
});

describe('copyWorkspace', () => {
  it('carries the workspace, its tables and their rows into the file', async () => {
    const result = await copyWorkspace(fakeSource(), target, WS);

    expect(result.tables).toBe(2);
    expect(result.rows).toBe(2);

    const tables = await target.tables.find();
    expect(tables.map((t) => t.name).sort()).toEqual(['Live', 'Parts']);

    const rows = await target.rows('t1').find();
    expect(rows.map((r) => r.data)).toEqual([
      { name: 'bolt', qty: 4 },
      // A key with no column of its own survives in the overflow column.
      { name: 'nut', qty: 9, note: 'spare' },
    ]);
  });

  it('makes a real SQL table with a real column per field', () => {
    // The point of the format: a converted file opens in any SQLite tool.
    return copyWorkspace(fakeSource(), target, WS).then(() => {
      const names = driver
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .all()
        .map((r) => String(r['name']));
      expect(names).toContain('_easydb');
      // The physical name keeps the table's own spelling — `sanitizeTableName`
      // strips what SQL cannot take, it does not lower-case.
      expect(names).toContain('Parts');
      const columns = driver
        .prepare(`PRAGMA table_info("Parts")`)
        .all()
        .map((c) => String(c['name']));
      expect(columns).toEqual(['_id', '_updatedAt', '_extra', 'name', 'qty']);
      const stored = driver.prepare(`SELECT name, qty FROM "Parts" ORDER BY name`).all();
      expect(stored).toEqual([
        { name: 'bolt', qty: 4 },
        { name: 'nut', qty: 9 },
      ]);
    });
  });

  it('copies a source-backed table but not its rows', async () => {
    const result = await copyWorkspace(fakeSource(), target, WS);

    // Its rows come from a server on every load, so a snapshot would be stale
    // data the app then ignores.
    expect(result.skipped).toEqual(['Live']);
    expect(await target.rows('t2').find()).toEqual([]);
    expect((await target.tables.findOne('t2'))?.name).toBe('Live');
  });

  it('rebuilds each setting key for the target instead of copying it', async () => {
    await copyWorkspace(fakeSource(), target, WS);

    const settings = await target.settings.find();
    expect(settings.map((s) => s.name).sort()).toEqual(['rows', 'theme']);
    // The physical key belongs to the store, not to the document that moved.
    expect(settings.every((s) => s.key === `${WS}::${s.name}`)).toBe(true);
    expect(settings.every((s) => s.workspaceId === WS)).toBe(true);
  });

  it('carries the workspace record, its plugins and its views', async () => {
    await copyWorkspace(fakeSource(), target, WS);

    expect((await target.workspaces.findOne(WS))?.pluginUrls).toEqual(['https://example.invalid/p.js']);
    expect((await target.plugins.find()).map((p) => p.url)).toEqual(['https://example.invalid/p.js']);
    expect((await target.viewTemplates.find()).map((t) => t.name)).toEqual(['cards']);
    expect((await target.viewInstances.find()).map((v) => v.id)).toEqual(['vi1']);
  });

  it('refuses a workspace that is not in the source', async () => {
    await expect(copyWorkspace(fakeSource(), target, 'nope')).rejects.toThrow(/No workspace/);
  });
});
