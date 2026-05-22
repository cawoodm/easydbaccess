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
  // Needed once schemas start having migrationStrategies.
  const { RxDBMigrationSchemaPlugin } = await import('rxdb/plugins/migration-schema');
  addRxPlugin(RxDBMigrationSchemaPlugin);

  const db = await createRxDatabase<EasyCollections>({
    name: 'easydb',
    storage: getRxStorageDexie(),
    ignoreDuplicate: true,
  });

  await db.addCollections({
    workspaces: { schema: workspaceSchema },
    tables: {
      schema: tableSchema,
      // v0 -> v1: added ColumnSpec.hidden. Existing column specs that lack
      // the field are simply treated as visible (hidden defaults to falsy).
      migrationStrategies: {
        // v0 -> v1: added ColumnSpec.hidden
        1: (doc) => doc,
        // v1 -> v2: added ColumnSpec.width
        2: (doc) => doc,
      },
    },
    rows: { schema: rowSchema },
    settings: { schema: settingSchema },
    plugins: { schema: pluginSchema },
  });

  return db;
}
