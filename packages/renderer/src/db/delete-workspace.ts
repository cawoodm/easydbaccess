// packages/renderer/src/db/delete-workspace.ts
//
// The mirror image of `clone-workspace.ts`, and it lives next to it for the same
// reason: a workspace's contents are spread over five collections, and only a
// module that may talk to Dexie directly can walk them. `store.settings` is a
// view over the ACTIVE workspace, so it cannot even see the settings of the
// workspace being deleted.
//
// Deleting a workspace has to take EVERYTHING with it. A leftover settings row
// is not inert: workspace ids are slugified names, so creating "Demo" again
// re-uses the id `demo` and the new workspace would inherit the old one's server
// URL, tokens and view-seed flags.

import type { Row, Setting, Table, ViewInstance, ViewTemplate } from '@easydb/shared';
import type { EasyDb } from './dexie-db.js';

/** How much a workspace holds. The confirm dialog quotes these numbers. */
export interface WorkspaceContents {
  tables: number;
  rows: number;
  views: number;
  templates: number;
  settings: number;
}

/** Ids of the tables belonging to one workspace. */
async function tableIdsOf(db: EasyDb, workspaceId: string): Promise<string[]> {
  const tables = (await db.tables.where('workspaceId').equals(workspaceId).toArray()) as Table[];
  return tables.map((t) => t.id);
}

/** What a delete would take with it — asked BEFORE the confirm dialog. */
export async function countWorkspaceContents(db: EasyDb, workspaceId: string): Promise<WorkspaceContents> {
  const tableIds = await tableIdsOf(db, workspaceId);
  const rows = tableIds.length === 0 ? 0 : await db.rows.where('tableId').anyOf(tableIds).count();
  return {
    tables: tableIds.length,
    rows,
    views: await db.viewInstances.where('workspaceId').equals(workspaceId).count(),
    templates: await db.viewTemplates.where('workspaceId').equals(workspaceId).count(),
    settings: await db.settings.where('workspaceId').equals(workspaceId).count(),
  };
}

/**
 * Remove a workspace and everything scoped to it: its tables and their rows, its
 * view instances and templates, and its settings. Returns what went, for the
 * message the caller shows.
 *
 * The workspace RECORD goes last. An interrupted delete then leaves a workspace
 * that still lists (and can be deleted again) rather than data nothing points at.
 *
 * Device-local `user` settings and the cached plugin bodies are deliberately
 * untouched — both are global to the device, not to a workspace (see
 * `db/user-settings.ts`). What did belong to this workspace is its `pluginUrls`,
 * which is a field ON the workspace record and goes with it.
 */
export async function deleteWorkspace(db: EasyDb, workspaceId: string): Promise<WorkspaceContents> {
  const counts = await countWorkspaceContents(db, workspaceId);

  const tableIds = await tableIdsOf(db, workspaceId);
  if (tableIds.length > 0) {
    const rows = (await db.rows.where('tableId').anyOf(tableIds).toArray()) as Row[];
    await db.rows.bulkDelete(rows.map((r) => r.id));
    await db.tables.bulkDelete(tableIds);
  }

  const instances = (await db.viewInstances.where('workspaceId').equals(workspaceId).toArray()) as ViewInstance[];
  await db.viewInstances.bulkDelete(instances.map((v) => v.id));

  const templates = (await db.viewTemplates.where('workspaceId').equals(workspaceId).toArray()) as ViewTemplate[];
  await db.viewTemplates.bulkDelete(templates.map((t) => t.id));

  const settings = (await db.settings.where('workspaceId').equals(workspaceId).toArray()) as Setting[];
  // `key` is optional on the type — a caller addresses a setting by `name` and the
  // store derives the key — but every STORED row has one.
  await db.settings.bulkDelete(settings.map((s) => s.key).filter((k): k is string => typeof k === 'string'));

  await db.workspaces.delete(workspaceId);
  return counts;
}
