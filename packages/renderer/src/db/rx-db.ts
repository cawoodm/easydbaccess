import { addRxPlugin, createRxDatabase, type RxCollection, type RxDatabase } from 'rxdb';
import { getRxStorageDexie } from 'rxdb/plugins/storage-dexie';
import {
  pluginSchema,
  rowSchema,
  settingSchema,
  tableSchema,
  workspaceSchema,
  type PluginRecord,
  type Row,
  type Setting,
  type Table,
  type Workspace,
} from '@easydb/shared';

export type EasyCollections = {
  workspaces: RxCollection<Workspace>;
  tables: RxCollection<Table>;
  rows: RxCollection<Row>;
  settings: RxCollection<Setting>;
  plugins: RxCollection<PluginRecord>;
};

export type EasyDatabase = RxDatabase<EasyCollections>;

let dbPromise: Promise<EasyDatabase> | null = null;

export function getDb(): Promise<EasyDatabase> {
  if (!dbPromise) dbPromise = init();
  return dbPromise;
}

async function init(): Promise<EasyDatabase> {
  if (import.meta.env.DEV) {
    const { RxDBDevModePlugin } = await import('rxdb/plugins/dev-mode');
    addRxPlugin(RxDBDevModePlugin);
  }

  const db = await createRxDatabase<EasyCollections>({
    name: 'easydb',
    storage: getRxStorageDexie(),
    ignoreDuplicate: true,
  });

  await db.addCollections({
    workspaces: { schema: workspaceSchema },
    tables: { schema: tableSchema },
    rows: { schema: rowSchema },
    settings: { schema: settingSchema },
    plugins: { schema: pluginSchema },
  });

  return db;
}
