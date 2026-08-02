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
import { inheritColumns, presentationFromBase, resolveWritability } from './projection-compute.js';
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

  // A projection window gets its OWN footer button for the join — the ordinary
  // "Edit columns" button next to it opens the normal column editor, because a
  // projection's columns behave like any table's once inherited.
  api.ui.registerTableButton({
    id: 'projection:edit',
    label: 'Edit Join',
    icon: 'call_merge',
    tooltip: 'Edit this projection’s sources, joins and which columns it includes',
    visible: (table) => table.source?.type === 'projection',
    onClick: (a, { tableId }) => void openProjectionEditor(a, { editTableId: tableId }),
  });
}

/**
 * The projection table's `columns`: each one's settings are inherited from the
 * source table the first time it appears, and are the user's from then on (see
 * `inheritColumns`). Resolves each source by name so the freshest column
 * definitions are copied.
 */
async function columnsForSpec(
  api: HostApi,
  workspaceId: string,
  spec: ProjectionSpec,
  existing: ColumnSpec[],
  deletedColumns: string[],
): Promise<ColumnSpec[]> {
  const all = await api.store.tables.find({ workspaceId });
  const byName = new Map<string, Table>();
  for (const t of all) if (!byName.has(t.name)) byName.set(t.name, t);
  const sourceColumnsByAlias: Record<string, ColumnSpec[]> = {};
  for (const s of spec.sources) {
    sourceColumnsByAlias[s.alias] = byName.get(s.tableName)?.columns ?? [];
  }
  return inheritColumns(spec, sourceColumnsByAlias, existing, deletedColumns);
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
    // Every table is a join candidate — INCLUDING the base, so a table can be
    // joined more than once (a self-join: `a → b → a`, or `a → a`). Each pick
    // becomes its own source with its own alias.
    candidates: all.map(toCand),
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
    const columns = await columnsForSpec(
      api,
      workspaceId,
      spec,
      editing?.columns ?? [],
      editing?.deletedColumns ?? [],
    );
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
