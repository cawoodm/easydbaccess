import type { DataStore, Row, Setting, Table } from '@easydb/shared';

/**
 * Copy one workspace from one store into another.
 *
 * This is what "Save this workspace as a file" runs. It is how ONE workspace is
 * extracted from a database that holds several. Both sides are plain
 * `DataStore`s, so the same function copies a file into the local database, or
 * one file into another.
 *
 * The copy is ADDITIVE. It never deletes from the source. A user who converts a
 * workspace and then goes back to browser storage still finds everything there.
 */

/** Rows written per call. Large enough to be one statement batch, small enough to report. */
const ROW_CHUNK = 1000;

export interface CopyProgress {
  /** What is being copied now, for a status line. */
  label: string;
  /** Rows written so far, over every table. */
  rows: number;
}

export interface CopyResult {
  tables: number;
  rows: number;
  /** Tables whose rows were left behind, because a provider owns them. */
  skipped: string[];
}

/**
 * Copy the workspace `workspaceId` from `from` into `to`.
 *
 * `to` must already be scoped to the same workspace id, because its settings
 * view builds each key from the active workspace.
 */
export async function copyWorkspace(from: DataStore, to: DataStore, workspaceId: string, report: (p: CopyProgress) => void = () => {}): Promise<CopyResult> {
  const workspace = await from.workspaces.findOne(workspaceId);
  if (!workspace) throw new Error(`No workspace "${workspaceId}" to copy`);
  await to.workspaces.upsert(workspace);

  // Plugin records are not workspace-scoped: they are this device's cache of
  // plugin bodies. They travel so an offline file still loads its plugins.
  const plugins = await from.plugins.find();
  if (plugins.length > 0) await to.plugins.bulkInsert(plugins);

  const settings = await from.settings.find();
  // `key` and `workspaceId` belong to the target store, which fills them itself.
  // Carrying the source's copies across would write a key of the wrong shape.
  const plain: Setting[] = settings.map((s) => ({ name: s.name, value: s.value }));
  if (plain.length > 0) await to.settings.bulkInsert(plain);

  const templates = await from.viewTemplates.find({ workspaceId });
  if (templates.length > 0) await to.viewTemplates.bulkInsert(templates);

  const tables = await from.tables.find({ workspaceId });
  const skipped: string[] = [];
  let rows = 0;

  for (const table of tables) {
    report({ label: table.name, rows });
    // The table doc goes in first. The target creates the SQL table and its
    // columns from it, so nothing can write a row before its table exists.
    await to.tables.upsert(table);
    if (ownedByProvider(table)) {
      // A source-backed table reads its rows from somewhere else on every load.
      // A snapshot here would be stale data the app then ignores.
      skipped.push(table.name);
      continue;
    }
    rows += await copyRows(from, to, table.id, rows, report);
  }

  // Views come last: an instance names the table it is bound to.
  const instances = await from.viewInstances.find({ workspaceId });
  if (instances.length > 0) await to.viewInstances.bulkInsert(instances);

  report({ label: 'done', rows });
  return { tables: tables.length, rows, skipped };
}

/** True when a provider, not the local store, answers `rows()` for this table. */
function ownedByProvider(table: Table): boolean {
  return Boolean(table.source);
}

/** Copy one table's rows in batches. Returns how many it wrote. */
async function copyRows(from: DataStore, to: DataStore, tableId: string, written: number, report: (p: CopyProgress) => void): Promise<number> {
  const source = from.rows(tableId);
  const target = to.rows(tableId);
  const all: Row[] = await source.find();
  for (let i = 0; i < all.length; i += ROW_CHUNK) {
    const chunk = all.slice(i, i + ROW_CHUNK);
    await target.bulkInsert(chunk);
    report({ label: `${chunk.length + i} of ${all.length} rows`, rows: written + i + chunk.length });
  }
  return all.length;
}
