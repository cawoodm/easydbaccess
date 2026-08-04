/**
 * sqlitefile — the row source behind "Browse .db file".
 *
 * A browsed object (table OR view) is a normal `Table` record carrying
 * `source: { type: 'sqlitefile', config: { path, objectName, isView } }`, so the
 * grid, the window manager and the views system treat it like any other table.
 * Its rows never live in the store: they are read from the file on demand, the
 * same shape `datasette-connect.ts` uses for a live connection.
 *
 * Read-only by construction. The file is one the user did not open as a
 * workspace, so nothing here writes — every mutating method throws rather than
 * pretending to succeed, and `Table.readonly` keeps the grid from offering
 * editors in the first place.
 *
 * Electron-only: `init` registers nothing when `window.easydb?.db` is absent,
 * which is always true in the browser build.
 */
import type { DataCollection, HostApi, PluginModule, Row, Table, Unsubscribe } from '@easydb/shared';
import type { EasydbDbBridge } from '../db/data-store-ipc.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'sqlitefile-source',
  name: 'Browse a database file',
  type: 'source',
  version: '0.1.0',
  description: 'Reads tables and views out of a .db file, read-only (Electron desktop build only).',
  author: 'Marc Cawood',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/sqlitefile-source.ts',
};

/** What a browsed table stores in `source.config`. */
export interface SqliteFileConfig {
  path: string;
  objectName: string;
  isView: boolean;
}

export function parseConfig(table: Table): SqliteFileConfig | null {
  const c = table.source?.config as Partial<SqliteFileConfig> | undefined;
  if (!c || typeof c.path !== 'string' || typeof c.objectName !== 'string') return null;
  return { path: c.path, objectName: c.objectName, isView: !!c.isView };
}

function readOnly(op: string): never {
  throw new Error(`This table is a read-only browse of a database file — ${op} is not possible. ` + `Use Import to bring the data into your workspace first.`);
}

/**
 * One browsed object's rows. Caches the last read so `find()` after a
 * subscription notification doesn't re-hit the file for every subscriber, and
 * exposes `refresh()` so the Refresh button re-reads it (the file may have
 * changed underneath us — we hold no lock on it).
 */
function createSqliteFileCollection(table: Table, bridge: EasydbDbBridge): DataCollection<Row> {
  const cfg = parseConfig(table);
  const subscribers = new Set<(rows: Row[]) => void>();
  let cache: Row[] | null = null;

  async function read(): Promise<Row[]> {
    if (!cfg) return [];
    const raw = await bridge.browseRows(cfg.path, cfg.objectName, table.columns);
    cache = raw.map((r) => ({
      id: r.id,
      tableId: table.id,
      data: r.data,
      updatedAt: 0,
    })) as Row[];
    return cache;
  }

  function notify(rows: Row[]): void {
    for (const fn of subscribers) fn(rows);
  }

  return {
    async find(): Promise<Row[]> {
      return cache ?? (await read());
    },
    async findOne(id: string): Promise<Row | undefined> {
      return (cache ?? (await read())).find((r) => r.id === id);
    },
    async count(): Promise<number> {
      return (cache ?? (await read())).length;
    },
    async refresh(): Promise<void> {
      notify(await read());
    },
    subscribe(fn: (rows: Row[]) => void): Unsubscribe {
      subscribers.add(fn);
      void (cache ? Promise.resolve(cache) : read()).then(fn);
      return () => void subscribers.delete(fn);
    },
    insert: () => readOnly('adding a row'),
    bulkInsert: () => readOnly('adding rows'),
    upsert: () => readOnly('changing a row'),
    patch: () => readOnly('changing a row'),
    remove: () => readOnly('deleting a row'),
    bulkRemove: () => readOnly('deleting rows'),
    clear: () => readOnly('clearing the table'),
  } as unknown as DataCollection<Row>;
}

export function init(api: HostApi): void {
  const bridge = window.easydb?.db;
  if (!bridge) return; // browser build — no file to browse

  if (typeof api.registerRowSource === 'function') {
    api.registerRowSource({
      type: 'sqlitefile',
      create: (table) => createSqliteFileCollection(table, bridge),
      // The schema is the file's, not ours — no column editor. See the field's
      // doc comment for why `Table.readonly` cannot carry this meaning.
      schemaEditable: false,
    });
  }
}
