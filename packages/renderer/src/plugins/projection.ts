// packages/renderer/src/plugins/projection.ts
//
// The Projection built-in: a virtual table whose rows are derived from other
// tables (a database view / JOIN). Registers three things:
//   - the `projection` row-source provider (rows computed live by
//     projection-collection.ts, closing over the routed store so it can read
//     the source tables and compose with other projections),
//   - a "New Projection" header button,
//   - an "Edit Projection" table button (projection windows only), which also
//     backs the `easydb:edit-projection` event the panel footer routes to.
//
// The editor UI lives in dialogs/projection-dialog.ts; this plugin gathers the
// candidate tables, opens the dialog, and compiles the returned spec into a
// Table (its `columns` are derived from the spec so the grid treats it like any
// table; the spec itself rides in `source.config`).

import type { ColumnSpec, HostApi, PluginModule, ProjectionSpec, Table } from '@easydb/shared';
import { cryptoUUID, slugTable } from '../util/ids.js';
import { presentationFromBase, resolveWritability } from './projection-compute.js';
import { createProjectionCollection } from './projection-collection.js';
import '../dialogs/projection-dialog.js';
import { ProjectionDialog, type ProjectionCandidate } from '../dialogs/projection-dialog.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'projection',
  name: 'Projection (virtual tables)',
  type: 'source',
  version: '0.1.0',
  description:
    'Virtual tables ("Projections") whose rows are derived live from other tables — database views and JOINs that look and act like tables.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h7v10H4z"/><path d="M13 7h7v10h-7z"/><path d="M11 12h2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/projection.ts',
};

export function init(api: HostApi): void {
  if (typeof api.registerRowSource === 'function') {
    api.registerRowSource({
      type: 'projection',
      create: (table) => createProjectionCollection(api.store, table),
    });
  }

  // "New Projection" lives on each table's footer, not the global header: the
  // table you launch it from becomes the projection's BASE (first source), so
  // the first table is implicit and you only pick the table(s) to join onto it.
  api.ui.registerTableButton({
    id: 'projection:new',
    label: 'New Projection',
    icon: 'add_box',
    tooltip: 'Create a virtual table using THIS table as the base (view / JOIN)',
    onClick: (a, { tableId }) => void openProjectionEditor(a, { baseTableId: tableId }),
  });

  api.ui.registerTableButton({
    id: 'projection:edit',
    label: 'Edit Projection',
    icon: 'table_view',
    tooltip: 'Edit this projection’s sources and columns',
    visible: (table) => table.source?.type === 'projection',
    onClick: (a, { tableId }) => void openProjectionEditor(a, { editTableId: tableId }),
  });

  // The panel footer's "Edit columns" reroutes here for projection tables.
  document.addEventListener('easydb:edit-projection', (e) => {
    const id = (e as CustomEvent<{ tableId: string }>).detail?.tableId;
    if (id) void openProjectionEditor(api, { editTableId: id });
  });
}

/** Compile a spec into the Table's stored `columns` (script/hidden/readonly flags). */
function compileColumns(spec: ProjectionSpec): ColumnSpec[] {
  const writable = resolveWritability(spec);
  return spec.columns.map((c) => {
    const col: ColumnSpec = { field: c.field, label: c.label, type: c.type };
    if (c.from.kind === 'script') col.script = c.from.script;
    if (c.hidden) col.hidden = true;
    if (!writable.has(c.field)) col.readonly = true;
    return col;
  });
}

/**
 * Open the editor. `editTableId` edits an existing projection; `baseTableId`
 * starts a new projection with that table as the fixed base (first source), so
 * only the join table(s) still need choosing.
 */
async function openProjectionEditor(
  api: HostApi,
  opts: { baseTableId?: string; editTableId?: string },
): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) return;
  const all = await api.store.tables.find({ workspaceId });
  const toCand = (t: Table): ProjectionCandidate => ({ id: t.id, name: t.name, columns: t.columns });
  const dlg = ProjectionDialog.instance ?? mountDialog();

  if (opts.editTableId) {
    const editing = all.find((t) => t.id === opts.editTableId) ?? null;
    if (!editing || editing.source?.type !== 'projection') return;
    dlg.open({
      // Every OTHER table is a candidate join source (not the projection itself).
      candidates: all.filter((t) => t.id !== editing.id).map(toCand),
      initial: { name: editing.name, spec: editing.source.config as unknown as ProjectionSpec },
      onSave: makeOnSave(api, workspaceId, editing),
    });
    return;
  }

  const baseTable = all.find((t) => t.id === opts.baseTableId);
  if (!baseTable) return;
  dlg.open({
    base: toCand(baseTable),
    // Join candidates: every table except the base (which is already source 0).
    candidates: all.filter((t) => t.id !== baseTable.id).map(toCand),
    onSave: makeOnSave(api, workspaceId, null, baseTable),
  });
}

/**
 * Build the persist callback shared by new/edit: compile columns, then write.
 * `base` is the table a NEW projection was launched from — its sort and filters
 * are carried over so the projection opens showing what the user was looking at.
 * (Hidden columns ride on the spec itself, so they survive later edits too.)
 */
function makeOnSave(
  api: HostApi,
  workspaceId: string,
  editing: Table | null,
  base?: Table,
): (name: string, spec: ProjectionSpec) => Promise<void> {
  return async (name, spec) => {
    const columns = compileColumns(spec);
    const tableReadonly = resolveWritability(spec).size === 0;
    const source: Table['source'] = {
      type: 'projection',
      config: spec as unknown as Record<string, unknown>,
    };
    if (editing) {
      await api.store.tables.patch(editing.id, {
        name,
        columns,
        source,
        readonly: tableReadonly,
        updatedAt: Date.now(),
      });
    } else {
      await api.store.tables.insert({
        id: cryptoUUID(),
        workspaceId,
        name,
        code: slugTable(name),
        columns,
        view: 'table',
        source,
        readonly: tableReadonly,
        // Inherit the base table's sort / filters, translated to this
        // projection's output fields.
        ...(base ? presentationFromBase(spec, base) : {}),
        updatedAt: Date.now(),
      });
    }
  };
}

function mountDialog(): ProjectionDialog {
  const el = document.createElement('projection-dialog') as ProjectionDialog;
  document.body.appendChild(el);
  return el;
}
