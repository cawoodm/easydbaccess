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
import { readColumnDrag } from '../table/column-drag.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'projection',
  name: 'Projection (virtual tables)',
  type: 'source',
  version: '0.1.0',
  description: 'Virtual tables ("Projections") whose rows are derived live from other tables — database views and JOINs that look and act like tables.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h7v10H4z"/><path d="M13 7h7v10h-7z"/><path d="M11 12h2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/projection.ts',
};

export function init(api: HostApi): void {
  if (typeof api.registerRowSource === 'function') {
    api.registerRowSource({
      type: 'projection',
      create: (table) => {
        // First use of this projection is the last moment its stored `readonly`
        // flags can be wrong without the user noticing — they are about to look
        // at it. Idempotent, so a no-op for anything already correct.
        void healProjectionTable(api, table);
        return createProjectionCollection(api.store, table);
      },
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

  // Drag a column header onto another table's window: the two tables and the
  // one column are already chosen, so the editor opens on them.
  api.ui.registerDropHandler((event, a) => handleColumnDrop(a, event));
}

/**
 * Bring existing projections in line with the current writability rule.
 *
 * `ColumnSpec.readonly` on a projection is derived from the spec, never set by
 * hand — `inheritColumns` overwrites it every time — but it is only recomputed
 * when a projection is created or its join re-saved. Joined columns used to be
 * read-only unconditionally, so every projection already in a workspace still
 * carries that flag and would stay uneditable until the user happened to open
 * Edit Join and press Save. Recomputing it once at load fixes them in place.
 *
 * Idempotent, and it writes only when something actually differs.
 */
async function healProjectionTable(api: HostApi, t: Table): Promise<void> {
  if (t.source?.type !== 'projection') return;
  const spec = t.source.config as unknown as ProjectionSpec | undefined;
  if (!spec || !Array.isArray(spec.sources)) return;
  const writable = resolveWritability(spec);
  const columns = t.columns.map((c) => {
    const shouldBeReadonly = !writable.has(c.field);
    if (shouldBeReadonly === (c.readonly === true)) return c;
    if (shouldBeReadonly) return { ...c, readonly: true };
    const next = { ...c };
    delete next.readonly;
    return next;
  });
  const tableReadonly = writable.size === 0;
  const unchanged = columns.every((c, i) => c === t.columns[i]) && (t.readonly ?? false) === tableReadonly;
  if (unchanged) return;
  await api.store.tables.patch(t.id, { columns, readonly: tableReadonly, updatedAt: Date.now() });
}

/** Repair every projection in the workspace. */
async function healProjectionWritability(api: HostApi): Promise<void> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) return;
  for (const t of await api.store.tables.find({ workspaceId })) await healProjectionTable(api, t);
}

/**
 * Run once the app is up: repair projections saved under the old rule.
 *
 * The per-table heal in `registerRowSource` covers the ones that arrive LATER —
 * pulled by sync from a device on an older build, restored from a dump, or made
 * by the SQL/Datasette importers — which a one-shot sweep at startup would
 * never see.
 */
export async function load(api: HostApi): Promise<void> {
  await healProjectionWritability(api);
}

/**
 * The projection table's `columns`: each one's settings are inherited from the
 * source table the first time it appears, and are the user's from then on (see
 * `inheritColumns`). Resolves each source by name so the freshest column
 * definitions are copied.
 */
async function columnsForSpec(api: HostApi, workspaceId: string, spec: ProjectionSpec, existing: ColumnSpec[], deletedColumns: string[]): Promise<ColumnSpec[]> {
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
  opts: {
    baseTableId?: string;
    editTableId?: string;
    /** Join this table onto the base, keyed on the base's `onField`. */
    join?: { tableId: string; onField: string } | undefined;
    filters?: Record<string, string> | undefined;
  },
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
  const joinTable = opts.join ? all.find((t) => t.id === opts.join?.tableId) : undefined;
  dlg.open({
    base: toCand(baseTable),
    // Every table is a join candidate — INCLUDING the base, so a table can be
    // joined more than once (a self-join: `a → b → a`, or `a → a`). Each pick
    // becomes its own source with its own alias.
    candidates: all.map(toCand),
    ...(joinTable && opts.join ? { join: toCand(joinTable), joinOn: opts.join.onField } : {}),
    ...(opts.filters ? { filters: opts.filters } : {}),
    onSave: makeOnSave(api, workspaceId, null, baseTable),
  });
}

/** A filter map with the empty entries dropped. */
function activeFilters(filters: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [f, q] of Object.entries(filters ?? {})) if (q && q.trim() !== '') out[f] = q;
  return out;
}

/**
 * A column dragged out of one table and dropped on another: offer a projection
 * of the FIRST with the second joined onto it.
 *
 * **The table you dragged FROM is the base**, and the dragged column is the join
 * key. Dragging `deptId` off People onto Dept means "take my People and bring
 * the matching Dept rows alongside" — the table you are working in stays the
 * subject, and the drop names what to enrich it with.
 *
 * It read the other way round until v0.0.372 (drop target as base, and only the
 * dragged column carried across from its own table), on the reasoning that you
 * carry a column TO the table you want it beside. In use that inverted the
 * result: the table the user was actually looking at became a single borrowed
 * column of someone else's projection.
 *
 * Returns false rather than handling anything when the drop was not on a table,
 * or was back on the column's own grid — that drop reorders the column, and the
 * grid has already dealt with it by the time this runs.
 */
async function handleColumnDrop(api: HostApi, event: DragEvent): Promise<boolean> {
  const payload = readColumnDrag(event);
  if (!payload) return false;
  const { tableIdAtNode } = await import('../window-mgr/table-window-manager.js');
  const targetId = tableIdAtNode(event.target);
  if (!targetId || targetId === payload.tableId) return false;

  const workspaceId = api.workspaceId();
  if (!workspaceId) return true;
  const all = await api.store.tables.find({ workspaceId });
  const target = all.find((t) => t.id === targetId);
  const source = all.find((t) => t.id === payload.tableId);
  if (!target || !source) return true;

  // The source's filters come off the LIVE grid (they travel with the drag);
  // the target's are the ones it has saved, which is the best a drop handler
  // can see of a window it is not inside.
  const filters = { ...payload.filters, ...activeFilters(target.filters) };
  let seed: Record<string, string> | undefined;
  if (Object.keys(filters).length > 0) {
    const keep = 'Keep the filters';
    const answer = await api.ui.dialogs.choice(
      `New projection over ${source.name}, joined to ${target.name} on “${payload.label}”. ` + 'Should it carry the filters those tables have on now, or read all their data?',
      [keep, 'All data'],
      'New projection',
    );
    if (answer === null) return true; // dismissed: no projection, but the drop was ours
    if (answer === keep) seed = filters;
  }

  await openProjectionEditor(api, {
    baseTableId: source.id,
    join: { tableId: target.id, onField: payload.field },
    ...(seed ? { filters: seed } : {}),
  });
  return true;
}

/**
 * Build the persist callback shared by new/edit: compile columns, then write.
 * `base` is the table a NEW projection was launched from — its sort and filters
 * are carried over so the projection opens showing what the user was looking at.
 * (Hidden columns ride on the spec itself, so they survive later edits too.)
 */
function makeOnSave(api: HostApi, workspaceId: string, editing: Table | null, base?: Table): (name: string, spec: ProjectionSpec) => Promise<void> {
  return async (name, spec) => {
    const columns = await columnsForSpec(api, workspaceId, spec, editing?.columns ?? [], editing?.deletedColumns ?? []);
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
