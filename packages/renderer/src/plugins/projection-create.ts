// packages/renderer/src/plugins/projection-create.ts
//
// Create a Projection table from a parsed spec — the one path used by every
// importer that produces projections rather than rows.
//
// The editor has its own path (`projection.ts`'s `makeOnSave`), because it also
// carries the base table's presentation across and can PATCH an existing
// projection. What is shared, and lives here, is the part an importer needs:
//   - re-point each source at the table that actually landed for it,
//   - refuse (rather than half-create) when a source cannot be resolved,
//   - inherit column settings from the sources, exactly as the editor does,
//   - name it without colliding with what is already in the workspace.
//
// Used by `sql-import` (a SELECT in a .sql script) and `datasette-import`
// (a SQL view in a Datasette database).

import type { ColumnSpec, HostApi, ProjectionSpec, SortSpec, Table } from '@easydb/shared';
import { uniqueTableName } from '../import/land-tables.js';
import { cryptoUUID, slugTable } from '../util/ids.js';
import { inheritColumns, resolveWritability } from './projection-compute.js';

/** A projection to create, as an importer has parsed it. */
export interface PendingProjection {
  name: string;
  spec: ProjectionSpec;
  /** Sort lifted from the query's ORDER BY — presentation, so it goes on the table. */
  sortBy?: SortSpec[] | undefined;
}

export interface CreateProjectionCtx {
  /**
   * Find the workspace table a spec source names, or undefined when there is
   * none. Callers differ in how forgiving this is — the SQL importer also
   * matches case-insensitively, because its own exporter lowercases
   * identifiers — so the lookup is theirs to define.
   */
  resolve(tableName: string): Table | undefined;
  /** Names already in use; the new projection is uniqued against them. */
  taken: Iterable<string>;
}

/**
 * Create the projection, or return null when any source is unresolved.
 *
 * Null rather than an empty projection on purpose: a projection over tables
 * that do not exist renders a blank grid with no hint why, which is worse than
 * not creating it and telling the user which table was missing.
 */
export async function createProjectionTable(api: HostApi, workspaceId: string, pending: PendingProjection, ctx: CreateProjectionCtx): Promise<Table | null> {
  const resolved = pending.spec.sources.map((source) => ({ source, table: ctx.resolve(source.tableName) }));
  if (resolved.some((r) => !r.table)) return null;

  const spec: ProjectionSpec = {
    ...pending.spec,
    // Bind to the name the table ACTUALLY landed under — an importer may have
    // uniqued it — and to the name alone (see `ProjectionSource`).
    sources: resolved.map(({ source, table }) => ({ ...source, tableName: table!.name })),
  };

  // Column settings are inherited from the sources exactly as they are when a
  // projection is built in the editor: the query carries only structure.
  const sourceColumnsByAlias: Record<string, ColumnSpec[]> = {};
  for (const { source, table } of resolved) sourceColumnsByAlias[source.alias] = table?.columns ?? [];
  const columns = inheritColumns(spec, sourceColumnsByAlias, [], []);

  const name = uniqueTableName(ctx.taken, pending.name);
  const table: Table = {
    id: cryptoUUID(),
    workspaceId,
    name,
    code: slugTable(name),
    columns,
    view: 'table',
    source: { type: 'projection', config: spec as unknown as Record<string, unknown> },
    readonly: resolveWritability(spec).size === 0,
    ...(pending.sortBy && pending.sortBy.length > 0 ? { sortBy: pending.sortBy } : {}),
    ...(spec.filters ? { filters: spec.filters } : {}),
    updatedAt: Date.now(),
  };
  await api.store.tables.insert(table);
  return table;
}
