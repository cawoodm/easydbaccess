// packages/renderer/src/db/legacy-idb/remap.ts
//
// Re-identifying a legacy workspace's documents so BOTH copies can exist.
//
// Pure: no IndexedDB, no store, no DOM. It takes documents and returns
// documents, which is what makes the rename case testable without a database.
//
// Why this exists at all: `copyWorkspace` writes every document under the id it
// already carries. That is right for a fresh copy and for an overwrite, but
// "keep both" needs new ids — `tables` is ONE collection keyed by table id
// across every workspace, so a second copy carrying the same table ids would
// collide with the first. `plugins/edb-file.ts` solves the same problem by
// cloning inside its scratch SQL bridge before copying; there is no bridge on
// this side of the migration, so the remap happens here instead.
//
// What is deliberately NOT remapped: a projection binds to its sources BY NAME
// (`ProjectionSpec.sources[].tableName`, see the root CLAUDE.md), so a copied
// projection finds the copied table without help. `settings` are re-keyed by the
// target store from its own active workspace, and `plugins` are this device's
// cache of plugin bodies rather than workspace data.

import type { Row, Table, ViewInstance, ViewTemplate, Workspace } from '@easydb/shared';
import type { LegacyWorkspaceMeta } from './read.js';

/** Old id → new id for everything a "keep both" copy has to re-key. */
export interface Remap {
  /** The workspace id the copy will be written under. */
  workspaceId: string;
  tables: Map<string, string>;
  templates: Map<string, string>;
  instances: Map<string, string>;
}

/**
 * The remap for a copy that keeps its own ids — a fresh workspace, or one that
 * replaces what is already there. Every lookup misses and every document is
 * returned unchanged.
 */
export function identityRemap(workspaceId: string): Remap {
  return { workspaceId, tables: new Map(), templates: new Map(), instances: new Map() };
}

/**
 * The remap for "keep both": a new id for the workspace and for each document
 * whose id is a primary key shared with the copy already in the database.
 */
export function buildRemap(meta: LegacyWorkspaceMeta, workspaceId: string, newId: () => string): Remap {
  return {
    workspaceId,
    tables: new Map(meta.tables.map((t) => [t.id, newId()] as const)),
    templates: new Map(meta.viewTemplates.map((v) => [v.id, newId()] as const)),
    instances: new Map(meta.viewInstances.map((v) => [v.id, newId()] as const)),
  };
}

/** Follow a remap, or keep what was there when it holds no entry for the id. */
function to(map: Map<string, string>, id: string): string {
  return map.get(id) ?? id;
}

export function remapWorkspace(w: Workspace, r: Remap): Workspace {
  if (w.id === r.workspaceId) return w;
  // `name` follows the id, as it does for a renamed `.edb` import. `title` is
  // display-only and is left alone: it is the user's label for this data, and it
  // is still their label for the copy.
  return { ...w, id: r.workspaceId, name: r.workspaceId };
}

export function remapTable(t: Table, r: Remap): Table {
  return { ...t, id: to(r.tables, t.id), workspaceId: r.workspaceId };
}

export function remapRow(row: Row, r: Remap): Row {
  return { ...row, tableId: to(r.tables, row.tableId) };
}

export function remapViewTemplate(v: ViewTemplate, r: Remap): ViewTemplate {
  return { ...v, id: to(r.templates, v.id), workspaceId: r.workspaceId };
}

export function remapViewInstance(v: ViewInstance, r: Remap): ViewInstance {
  return {
    ...v,
    id: to(r.instances, v.id),
    workspaceId: r.workspaceId,
    tableId: to(r.tables, v.tableId),
    templateId: to(r.templates, v.templateId),
  };
}

/**
 * One workspace's documents, all put through the same remap. Rows are not here:
 * they are remapped one table at a time as they are read (see `legacy-store.ts`).
 */
export function applyRemap(meta: LegacyWorkspaceMeta, r: Remap): LegacyWorkspaceMeta {
  return {
    workspace: remapWorkspace(meta.workspace, r),
    tables: meta.tables.map((t) => remapTable(t, r)),
    settings: meta.settings,
    plugins: meta.plugins,
    viewTemplates: meta.viewTemplates.map((v) => remapViewTemplate(v, r)),
    viewInstances: meta.viewInstances.map((v) => remapViewInstance(v, r)),
  };
}

/**
 * New table id → the id that table has in the legacy database, so a reader given
 * the remapped id can still find its rows.
 */
export function legacyTableIds(r: Remap): Map<string, string> {
  return new Map(Array.from(r.tables, ([legacy, fresh]) => [fresh, legacy] as const));
}
