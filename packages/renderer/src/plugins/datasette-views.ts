// packages/renderer/src/plugins/datasette-views.ts
//
// Import a Datasette database's SQL VIEWS as Projections.
//
// A view is not data — it is a query over tables. Importing one as a table
// would snapshot its current rows and cut it loose from the tables it reads,
// which is exactly what a view is not. A Projection is the same idea in this
// app: a virtual table computed live from other tables. So a view maps onto a
// projection, not onto a table.
//
// The route is: read each view's `CREATE VIEW … AS SELECT …` out of
// `sqlite_master` (see `fetchViewDefinitions`), hand it to the SQL parser that
// already exists for `.sql` import, and create a projection from the resulting
// spec. Anything the parser cannot model — a subquery, an aggregate, a window
// function — is reported per view rather than half-imported.
//
// The source tables must already be in the workspace: a projection over tables
// that are not here would render an empty grid. Datasette tables land as
// `db/table`, while a view's SQL names them bare (`select … from articles`),
// so resolution tries the qualified name first.

import type { HostApi, Table } from '@easydb/shared';
import { DatasetteError, discoverViews, parseDatasetteUrl, type ViewRef } from './datasette-client.js';
import { createProjectionTable } from './projection-create.js';
import { parseSqlScript } from './sql-parse.js';

export interface ImportViewsResult {
  /** Projection names created, in the order they were created. */
  created: string[];
  /** Views that could not be imported, each with the reason. */
  skipped: Array<{ name: string; reason: string }>;
  /** Views found at the source, whether or not they were imported. */
  found: number;
}

/**
 * Which workspace table a view's SQL means by `name`.
 *
 * Datasette tables are imported as `db/table`, so the qualified form is tried
 * first; a bare match is the fallback for a workspace where the user renamed
 * them. Case-insensitive because SQLite identifiers are.
 */
function makeResolver(tables: Table[], db: string): (name: string) => Table | undefined {
  const byLower = new Map<string, Table>();
  for (const t of tables) if (!byLower.has(t.name.toLowerCase())) byLower.set(t.name.toLowerCase(), t);
  return (name) => byLower.get(`${db}/${name}`.toLowerCase()) ?? byLower.get(name.toLowerCase());
}

/**
 * Turn the views found at `input` into projections. Returns what happened so
 * the caller can report it; throws only when the views cannot be READ at all
 * (a `DatasetteError` explaining that the SQL endpoint is off).
 */
export async function importDatasetteViews(api: HostApi, input: string): Promise<ImportViewsResult> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('datasette-views: no active workspace');
  const ref = parseDatasetteUrl(input);
  const views = await discoverViews((u) => api.backend.fetch(u), ref);
  return createProjectionsForViews(api, workspaceId, views);
}

/**
 * The half of {@link importDatasetteViews} that touches the store — separated
 * so the caller can fetch the views once and reuse them (the import flow
 * already knows whether any exist before it asks the user).
 */
export async function createProjectionsForViews(api: HostApi, workspaceId: string, views: ViewRef[]): Promise<ImportViewsResult> {
  const result: ImportViewsResult = { created: [], skipped: [], found: views.length };
  if (views.length === 0) return result;

  const tables = (await api.store.tables.find()).filter((t) => t.workspaceId === workspaceId);
  const taken = new Set(tables.map((t) => t.name));
  // Projections created here join the pool, so one view can read another.
  const pool: Table[] = [...tables];

  for (const v of views) {
    const parsed = parseSqlScript(v.sql);
    const projection = parsed.projections[0];
    if (!projection) {
      result.skipped.push({ name: v.name, reason: parsed.unsupported[0] ?? 'its SELECT could not be modelled as a projection' });
      continue;
    }
    // The parser names the projection after the view; keep Datasette's own
    // name, which is what the user saw in the instance.
    const created = await createProjectionTable(
      api,
      workspaceId,
      { name: `${v.db}/${v.name}`, spec: projection.spec, ...(projection.sortBy ? { sortBy: projection.sortBy } : {}) },
      { resolve: makeResolver(pool, v.db), taken },
    );
    if (!created) {
      const missing = projection.spec.sources.map((s) => s.tableName).join(', ');
      result.skipped.push({ name: v.name, reason: `its source tables are not in this workspace (${missing}) — import them first` });
      continue;
    }
    pool.push(created);
    taken.add(created.name);
    result.created.push(created.name);
    // A view the parser only partly understood still becomes a projection, but
    // the user has to know it is not the whole query.
    if (parsed.unsupported.length > 0) {
      result.skipped.push({ name: v.name, reason: `imported, but part of the query was not modelled: ${parsed.unsupported.slice(0, 2).join('; ')}` });
    }
  }
  return result;
}

/** One toast summarising an import — including, explicitly, what did not work. */
export function reportViewImport(api: HostApi, res: ImportViewsResult): void {
  if (res.found === 0) {
    api.ui.dialogs.toast('That Datasette database defines no views.', { kind: 'info', title: 'Datasette views' });
    return;
  }
  const detail = res.skipped.length > 0 ? ` ${res.skipped.length} not fully imported: ${res.skipped.map((s) => `${s.name} — ${s.reason}`).join('; ')}` : '';
  if (res.created.length === 0) {
    api.ui.dialogs.toast(`No views could be imported as projections.${detail}`, { kind: 'warning', title: 'Datasette views' });
    return;
  }
  api.ui.dialogs.toast(`Imported ${res.created.length} of ${res.found} view${res.found === 1 ? '' : 's'} as projections.${detail}`, {
    kind: res.skipped.length > 0 ? 'warning' : 'success',
    title: 'Datasette views',
  });
}

/**
 * The `.json` endpoint for one view. Datasette serves a view exactly like a
 * table, so this URL feeds straight into the ordinary table importer — paging,
 * progress bar, column inference and all.
 */
export function viewTableUrl(base: string, v: ViewRef): string {
  return `${base}/${encodeURIComponent(v.db)}/${encodeURIComponent(v.name)}`;
}

/**
 * How the user wants a database's views brought in.
 *  - `projection` — live: the view's QUERY becomes a projection over the
 *    imported tables, and re-computes whenever they change.
 *  - `table`      — a snapshot: the view's ROWS become an ordinary local table,
 *    frozen at import time and yours to edit.
 * The two are genuinely different things, which is why this asks rather than
 * picking one. A view whose SQL is too complex to model can still be imported
 * as a table, so the snapshot is also the fallback.
 */
export type ViewImportMode = 'projection' | 'table';

/** Views defined at `input`, or null when the instance will not tell us. */
export async function findViews(api: HostApi, input: string): Promise<ViewRef[] | null> {
  try {
    return await discoverViews((u) => api.backend.fetch(u), parseDatasetteUrl(input));
  } catch (err) {
    if (err instanceof DatasetteError) return null; // SQL endpoint off
    throw err;
  }
}

/** Ask how to bring `views` in. Null when the user declines. */
export async function askViewImportMode(api: HostApi, views: ViewRef[], lead: string): Promise<ViewImportMode | null> {
  const names = views
    .slice(0, 5)
    .map((v) => v.name)
    .join(', ');
  const choice = await api.ui.dialogs.choice(
    `${lead} ${views.length} view${views.length === 1 ? '' : 's'} (${names}${views.length > 5 ? ', …' : ''}).\n\n` + `A view is a query rather than stored rows, so it can come in either way.`,
    ['As projections (live)', 'As tables (snapshot)'],
    'Datasette views',
  );
  if (!choice) return null;
  return choice.startsWith('As projections') ? 'projection' : 'table';
}

/**
 * Offer to import a database's views right after its tables landed — the only
 * moment the tables a view reads are guaranteed to exist.
 *
 * Silent when there are no views, and silent when the instance will not answer
 * the SQL query that lists them: an import that otherwise succeeded must not
 * end on an error about an optional extra.
 *
 * `importAsTables` is injected rather than imported: the table importer lives
 * in `datasette-import.ts`, which already imports this module, and taking the
 * dependency back would make that a cycle.
 */
export async function offerViewImport(api: HostApi, input: string, importAsTables: (urls: string[]) => Promise<void>): Promise<void> {
  const views = await findViews(api, input);
  if (!views || views.length === 0) return;

  const mode = await askViewImportMode(api, views, 'This database also defines');
  if (!mode) return;
  await runViewImport(api, parseDatasetteUrl(input).base, views, mode, importAsTables);
}

/** Carry out a chosen mode over an already-discovered set of views. */
export async function runViewImport(api: HostApi, base: string, views: ViewRef[], mode: ViewImportMode, importAsTables: (urls: string[]) => Promise<void>): Promise<void> {
  if (mode === 'table') {
    // The table importer emits its own per-batch summary, so this path stays
    // quiet rather than adding a second one.
    await importAsTables(views.map((v) => viewTableUrl(base, v)));
    return;
  }
  const workspaceId = api.workspaceId();
  if (!workspaceId) return;
  reportViewImport(api, await createProjectionsForViews(api, workspaceId, views));
}
