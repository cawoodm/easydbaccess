import Dexie, { type Table as DexieTable } from 'dexie';
import type { PluginRecord, Row, Setting, Table, Workspace } from '@easydb/shared';

/**
 * easyDB local store: one IndexedDB database, one Dexie table per logical
 * collection. Schema strings follow Dexie's syntax — leading column is the
 * primary key; subsequent comma-separated columns are secondary indexes.
 *
 * Versioning: bump `db.version(N)` each time a schema field needs to be
 * indexed/unindexed. Column-shape evolution (rewriting existing rows on the
 * way up) is handled inside `.upgrade()` callbacks.
 *
 * The DB is exposed as plain Dexie (no subclass) because `Dexie.tables` is
 * already an instance member on the base class — subclassing would force a
 * rename. Typed accessors live on `EasyDb` below.
 */

const DB_NAME = 'easydb';

export interface EasyDb {
  raw: Dexie;
  workspaces: DexieTable<Workspace, string>;
  tables: DexieTable<Table, string>;
  rows: DexieTable<Row, string>;
  settings: DexieTable<Setting, string>;
  plugins: DexieTable<PluginRecord, string>;
}

let instance: EasyDb | null = null;

export function getDexie(): EasyDb {
  if (instance) return instance;

  const raw = new Dexie(DB_NAME);
  raw.version(1).stores({
    workspaces: 'id',
    tables: 'id, workspaceId, updatedAt',
    rows: 'id, tableId, updatedAt',
    settings: 'key',
    plugins: 'url',
  });

  instance = {
    raw,
    workspaces: raw.table<Workspace, string>('workspaces'),
    tables: raw.table<Table, string>('tables'),
    rows: raw.table<Row, string>('rows'),
    settings: raw.table<Setting, string>('settings'),
    plugins: raw.table<PluginRecord, string>('plugins'),
  };
  return instance;
}
