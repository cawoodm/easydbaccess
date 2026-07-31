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
import { resolveWritability } from './projection-compute.js';
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

  api.ui.registerHeaderButton({
    id: 'projection:new',
    label: 'New Projection',
    icon: 'table_view',
    tooltip: 'Create a virtual table (a view / JOIN of other tables)',
    onClick: () => void openProjectionEditor(api),
  });

  api.ui.registerTableButton({
    id: 'projection:edit',
    label: 'Edit Projection',
    icon: 'table_view',
    tooltip: 'Edit this projection’s sources and columns',
    visible: (table) => table.source?.type === 'projection',
    onClick: (a, { tableId }) => void openProjectionEditor(a, tableId),
  });

  // The panel footer's "Edit columns" reroutes here for projection tables.
  document.addEventListener('easydb:edit-projection', (e) => {
    const id = (e as CustomEvent<{ tableId: string }>).detail?.tableId;
    if (id) void openProjectionEditor(api, id);
  });
}

/** Compile a spec into the Table's stored `columns` (script + readonly flags). */
function compileColumns(spec: ProjectionSpec): ColumnSpec[] {
  const writable = resolveWritability(spec);
  return spec.columns.map((c) => {
    const col: ColumnSpec = { field: c.field, label: c.label, type: c.type };
    if (c.from.kind === 'script') col.script = c.from.script;
    if (!writable.has(c.field)) col.readonly = true;
    return col;
  });
}

async function openProjectionEditor(api: HostApi, tableId?: string): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) return;
  const all = await api.store.tables.find({ workspaceId });
  const editing = tableId ? (all.find((t) => t.id === tableId) ?? null) : null;

  // Candidate sources: every other table in the workspace (excluding the one
  // being edited, so a projection cannot pick itself as a source).
  const candidates: ProjectionCandidate[] = all
    .filter((t) => t.id !== tableId)
    .map((t) => ({ id: t.id, name: t.name, columns: t.columns }));

  const dlg = ProjectionDialog.instance ?? mountDialog();
  const initial =
    editing && editing.source?.type === 'projection'
      ? { name: editing.name, spec: editing.source.config as unknown as ProjectionSpec }
      : undefined;

  dlg.open({
    candidates,
    initial,
    onSave: async (name, spec) => {
      // Guard a direct self-cycle by name (transitive cycles are caught at
      // compute time by projection-collection's guard).
      if (spec.sources.some((s) => s.tableName === name && editing && s.tableName === editing.name)) {
        throw new Error('A projection cannot use itself as a source.');
      }
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
          updatedAt: Date.now(),
        });
      }
    },
  });
}

function mountDialog(): ProjectionDialog {
  const el = document.createElement('projection-dialog') as ProjectionDialog;
  document.body.appendChild(el);
  return el;
}
