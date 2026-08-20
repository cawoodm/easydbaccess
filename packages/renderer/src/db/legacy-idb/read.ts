// packages/renderer/src/db/legacy-idb/read.ts
//
// Reading the browser store this app used BEFORE SQLite.
//
// Until v0.0.383 the browser kept workspaces in an IndexedDB database named
// `easydb`, through Dexie. Dexie is gone and is not coming back for this: it
// wrote plain structured-clone objects, so raw IndexedDB reads them, and the
// documents are the same `@easydb/shared` types the SQLite store holds today.
//
// Read-only by design. Nothing in this module writes to the legacy database, so
// the old copy survives a migration and an older build can still open it. The
// one exception is the empty shell a detection probe can create on a browser
// with no `indexedDB.databases()` — that gets deleted again, see `openLegacyDb`.

import type { PluginRecord, Row, Setting, Table, ViewInstance, ViewTemplate, Workspace } from '@easydb/shared';

/** The database name every build before the SQLite flip wrote. */
export const LEGACY_DB_NAME = 'easydb';

/** One IndexedDB request as a promise. */
function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** A read-only handle on the legacy database. */
export interface LegacyDb {
  /** Stores this database actually has — a v1 database has no view stores. */
  readonly stores: readonly string[];
  all<T>(store: string): Promise<T[]>;
  /** Everything in `store` whose `index` equals `value`. Falls back to a scan. */
  byIndex<T>(store: string, index: string, value: IDBValidKey): Promise<T[]>;
  /** How many documents match, without reading them. */
  countByIndex(store: string, index: string, value: IDBValidKey): Promise<number>;
  close(): void;
}

/**
 * Open the legacy database for reading, or `null` when there is none.
 *
 * Opened with **no version**, which never triggers an upgrade — so this cannot
 * modify a database an older build still uses, and cannot be blocked by a tab
 * that has it open.
 *
 * The catch is that opening a database that does not exist CREATES it, empty.
 * That is unavoidable on Firefox, where `indexedDB.databases()` does not exist
 * and there is no way to ask. So the probe notices the create (`upgradeneeded`
 * fires for it, and only for it), then closes and deletes the shell again,
 * leaving no trace. This is why detection does not have to be silent on Firefox
 * the way the old `noticeOrphanedBrowserData` was.
 */
export async function openLegacyDb(): Promise<LegacyDb | null> {
  if (typeof indexedDB === 'undefined') return null;
  const req = indexedDB.open(LEGACY_DB_NAME);
  let created = false;
  req.onupgradeneeded = () => {
    created = true;
  };
  let db: IDBDatabase;
  try {
    db = await promisify(req);
  } catch {
    // A browser that refuses IndexedDB outright (private mode on some builds).
    return null;
  }
  // Nothing was here: the open made an empty database. Undo that.
  if (created || db.objectStoreNames.length === 0) {
    db.close();
    try {
      indexedDB.deleteDatabase(LEGACY_DB_NAME);
    } catch {
      /* Leaving an empty shell behind is untidy, not harmful. */
    }
    return null;
  }
  return wrap(db);
}

function wrap(db: IDBDatabase): LegacyDb {
  const stores = Array.from(db.objectStoreNames);
  const has = (name: string) => stores.includes(name);

  /** One read transaction over `store`, or null when the store is absent. */
  const read = (store: string): IDBObjectStore | null => (has(store) ? db.transaction(store, 'readonly').objectStore(store) : null);

  return {
    stores,
    close: () => db.close(),

    async all<T>(store: string): Promise<T[]> {
      const os = read(store);
      if (!os) return [];
      return (await promisify(os.getAll())) as T[];
    },

    async byIndex<T>(store: string, index: string, value: IDBValidKey): Promise<T[]> {
      const os = read(store);
      if (!os) return [];
      // A v1/v2 database can be missing an index a later version added. Reading
      // everything and narrowing here is slower but always correct.
      if (!os.indexNames.contains(index)) {
        const all = (await promisify(os.getAll())) as Array<Record<string, unknown>>;
        return all.filter((d) => d[index] === value) as T[];
      }
      return (await promisify(os.index(index).getAll(value))) as T[];
    },

    async countByIndex(store: string, index: string, value: IDBValidKey): Promise<number> {
      const os = read(store);
      if (!os) return 0;
      if (!os.indexNames.contains(index)) {
        const all = (await promisify(os.getAll())) as Array<Record<string, unknown>>;
        return all.filter((d) => d[index] === value).length;
      }
      return promisify(os.index(index).count(value));
    },
  };
}

/** What one stranded workspace holds, for the offer and the conflict prompt. */
export interface LegacyWorkspaceSummary {
  id: string;
  name: string;
  title?: string | undefined;
  tables: number;
  rows: number;
  views: number;
}

/** What the legacy database holds, in the terms the offer dialog needs. */
export interface LegacySummary {
  workspaces: LegacyWorkspaceSummary[];
  tables: number;
  rows: number;
}

/**
 * Summarise the legacy database without materialising its rows.
 *
 * Row counts go through the `tableId` index one table at a time, because the
 * point of the summary is to be cheap enough to show in a dialog on a phone.
 */
export async function summariseLegacy(db: LegacyDb): Promise<LegacySummary> {
  const workspaces = await db.all<Workspace>('workspaces');
  const out: LegacyWorkspaceSummary[] = [];
  let tables = 0;
  let rows = 0;
  for (const w of workspaces) {
    const own = await db.byIndex<Table>('tables', 'workspaceId', w.id);
    let ownRows = 0;
    for (const t of own) ownRows += await db.countByIndex('rows', 'tableId', t.id);
    const views = (await db.byIndex<ViewInstance>('viewInstances', 'workspaceId', w.id)).length;
    out.push({ id: w.id, name: w.name, title: w.title, tables: own.length, rows: ownRows, views });
    tables += own.length;
    rows += ownRows;
  }
  return { workspaces: out, tables, rows };
}

/**
 * One legacy workspace and everything scoped to it EXCEPT its rows.
 *
 * The rows are left out on purpose. They are the only unbounded part, and
 * `copyWorkspace` already streams them one table at a time; holding every row of
 * every table here first would undo that on the device where it matters most.
 * Read them with {@link readLegacyRows}.
 */
export interface LegacyWorkspaceMeta {
  workspace: Workspace;
  tables: Table[];
  settings: Setting[];
  plugins: PluginRecord[];
  viewTemplates: ViewTemplate[];
  viewInstances: ViewInstance[];
}

/**
 * Read one workspace's documents, minus the rows.
 *
 * `settings` handles both shapes. From schema v3 a row carries `workspaceId` and
 * `name`; before that the store was global and the primary key WAS the name,
 * with neither field present. An unscoped row belonged to every workspace —
 * exactly what the v3 upgrade did with it — so it is reported for whichever
 * workspace is being read.
 */
export async function readLegacyWorkspaceMeta(db: LegacyDb, workspaceId: string): Promise<LegacyWorkspaceMeta | null> {
  const workspaces = await db.all<Workspace>('workspaces');
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;

  const allSettings = await db.all<Setting & { key?: string }>('settings');
  const settings = allSettings
    .filter((s) => s.workspaceId === undefined || s.workspaceId === workspaceId)
    // A pre-v3 row has no `name`; its primary key WAS the name.
    .map((s) => ({ name: s.name ?? s.key ?? '', value: s.value }))
    .filter((s) => s.name !== '');

  return {
    workspace,
    tables: await db.byIndex<Table>('tables', 'workspaceId', workspaceId),
    settings,
    plugins: await db.all<PluginRecord>('plugins'),
    viewTemplates: await db.byIndex<ViewTemplate>('viewTemplates', 'workspaceId', workspaceId),
    viewInstances: await db.byIndex<ViewInstance>('viewInstances', 'workspaceId', workspaceId),
  };
}

/** One legacy table's rows, by the id it carries IN the legacy database. */
export function readLegacyRows(db: LegacyDb, legacyTableId: string): Promise<Row[]> {
  return db.byIndex<Row>('rows', 'tableId', legacyTableId);
}

/** Remove the legacy database. Offered separately, never as part of a copy. */
export async function deleteLegacyDb(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('The old database could not be removed'));
    // Another tab still holds it open. Not an error: it goes when that tab does.
    req.onblocked = () => resolve();
  });
}
