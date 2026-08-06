// packages/renderer/src/plugins/commandlet-run.ts
//
// Runs what `commandlet-lang.ts` parsed. Every effect here already exists
// somewhere in the app; this module only routes to it:
//   - filters and sort are a patch of `Table.filters` / `sortBy`, which
//     `data-table.applyTable()` re-reads on its own subscription,
//   - windows come from `focusTableWindow` / `revealViewWindow`,
//   - search rides the `easydb:table-search` / `easydb:set-search` events,
//   - `cmd/` looks up the id in `registries.commands`.

import type { CommandSpec, SortSpec, Table, ViewInstance } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { focusTableWindow } from '../window-mgr/table-window-manager.js';
import { revealViewWindow } from '../window-mgr/view-window-manager.js';
import { CommandletError, parseCommandlets, substituteCommandlet, type Commandlet } from './commandlet-lang.js';

/**
 * Where a commandlet was invoked from, when that is known. A link clicked inside
 * a cell knows its table, column and value; the same string typed into the
 * palette or arriving in a `#hash` knows none of them.
 */
export interface CommandletContext {
  tableId?: string | undefined;
  field?: string | undefined;
  value?: string | undefined;
  /** Extra placeholders, e.g. `HASH` and `1`…`9` from an anchor rule. */
  vars?: Record<string, string> | undefined;
}

/** Parse and run a `;`-separated commandlet string, left to right. */
export async function runCommandletString(input: string, ctx: CommandletContext = {}): Promise<void> {
  const commandlets = parseCommandlets(input);
  const vars = await placeholders(ctx);
  for (const parsed of commandlets) {
    await runOne(substituteCommandlet(parsed, vars));
  }
}

/**
 * Is this string a commandlet this workspace can actually run? Same parse and
 * the same lookups as running it — the table, the columns, the view, the
 * command id — but nothing is written.
 *
 * Exists so the dialog can say whether what is being typed will work BEFORE it
 * is run, instead of the user finding out from an error toast afterwards.
 */
export async function checkCommandletString(input: string, ctx: CommandletContext = {}): Promise<{ ok: boolean; message: string }> {
  const text = input.trim();
  if (!text) return { ok: false, message: '' };
  let parsed: Commandlet[];
  try {
    parsed = parseCommandlets(text);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const vars = await placeholders(ctx);
  const summaries: string[] = [];
  for (const cmd of parsed) {
    try {
      summaries.push(await describe(substituteCommandlet(cmd, vars)));
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, message: summaries.join(', then ') };
}

/** One line saying what a commandlet WOULD do, throwing if it could not. */
async function describe(cmd: Commandlet): Promise<string> {
  switch (cmd.verb) {
    case 'goto': {
      const table = await findTableByName(cmd.targets[0] ?? '');
      const fields = Object.keys(cmd.filters).map((k) => resolveField(table, k));
      const sort = parseSort(cmd.options.sort, table);
      const parts = [`open ${table.name}`];
      if (fields.length > 0) parts.push(`filter ${fields.join(' + ')}`);
      if (cmd.options.clear !== undefined) parts.push('clear filters');
      if (cmd.options.search !== undefined) parts.push(`search "${cmd.options.search}"`);
      if (sort && sort.length > 0) parts.push(`sort by ${sort.map((s) => `${s.field}${s.asc ? '' : ' ↓'}`).join(', ')}`);
      return parts.join(', ');
    }
    case 'search':
      return `search all tables for "${cmd.targets[0] ?? ''}"`;
    case 'view':
      return `open view "${(await findViewByName(cmd.targets[0] ?? '')).name}"`;
    case 'cmd':
      return `run "${(await findCommandById(cmd.targets[0] ?? '')).title}"`;
    case 'preview':
    case 'ui':
      throw new CommandletError(`"${cmd.verb}" is not wired up yet.`);
  }
}

/** `$TABLE`, `$FIELD`, `$VALUE`, `$WORKSPACE` plus whatever the caller supplied. */
async function placeholders(ctx: CommandletContext): Promise<Record<string, string>> {
  const app = await getContext();
  const vars: Record<string, string> = { WORKSPACE: app.workspaceId, ...(ctx.vars ?? {}) };
  if (ctx.field !== undefined) vars.FIELD = ctx.field;
  if (ctx.value !== undefined) vars.VALUE = ctx.value;
  if (ctx.tableId) {
    const table = await app.store.tables.findOne(ctx.tableId);
    if (table) vars.TABLE = table.name;
  }
  return vars;
}

async function runOne(cmd: Commandlet): Promise<void> {
  switch (cmd.verb) {
    case 'goto':
      return runGoto(cmd);
    case 'search':
      return runSearch(cmd);
    case 'view':
      return runView(cmd);
    case 'cmd':
      return runCommandId(cmd);
    case 'preview':
    case 'ui':
      throw new CommandletError(`"${cmd.verb}" is not wired up yet.`);
  }
}

// -- goto ---------------------------------------------------------------------

async function runGoto(cmd: Commandlet): Promise<void> {
  const name = cmd.targets[0] ?? '';
  const table = await findTableByName(name);

  const patch: Partial<Table> = {};
  const merged = cmd.options.clear === undefined ? { ...(table.filters ?? {}) } : {};
  for (const [key, expr] of Object.entries(cmd.filters)) {
    const field = resolveField(table, key);
    // An empty value is how a commandlet REMOVES a filter, so a link can widen a
    // view as well as narrow it.
    if (expr === '') delete merged[field];
    else merged[field] = expr;
  }
  if (Object.keys(cmd.filters).length > 0 || cmd.options.clear !== undefined) {
    patch.filters = Object.keys(merged).length > 0 ? merged : undefined;
  }

  const sort = parseSort(cmd.options.sort, table);
  if (sort) {
    // `sortColumn`/`sortAsc` mirror the first key — the same shape data-table
    // writes, so an older reader still sees the primary sort.
    patch.sortBy = sort.length > 0 ? sort : undefined;
    patch.sortColumn = sort[0]?.field;
    patch.sortAsc = sort[0] ? sort[0].asc : undefined;
  }

  if (Object.keys(patch).length > 0) {
    const app = await getContext();
    await app.store.tables.patch(table.id, { ...patch, updatedAt: Date.now() } as Partial<Table>);
  }

  focusTableWindow(table.id);

  const search = cmd.options.search;
  if (search !== undefined) {
    document.dispatchEvent(new CustomEvent('easydb:table-search', { detail: { tableId: table.id, query: search } }));
  }
}

/** `-Field` is descending; several keys are comma-separated, priority order. */
function parseSort(spec: string | undefined, table: Table): SortSpec[] | null {
  if (spec === undefined) return null;
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('-') ? { field: resolveField(table, s.slice(1)), asc: false } : { field: resolveField(table, s), asc: true }));
}

/**
 * Map what the commandlet wrote to a real column field, by field name OR label,
 * case-insensitively — the same rule `searchRowsByField` applies to a
 * `field:value` search term, so `Book` finds the column labelled "Book" even
 * though its field is `book`.
 *
 * An unknown column is refused rather than written. A filter on a field no
 * column has cannot be seen or cleared in the grid (there is no funnel for it)
 * and matches nothing, so writing one empties the table with no visible cause.
 */
function resolveField(table: Table, key: string): string {
  const byName = new Map<string, string>();
  for (const c of table.columns ?? []) {
    byName.set(c.field.toLowerCase(), c.field);
    if (c.label) byName.set(c.label.toLowerCase(), c.field);
  }
  const real = byName.get(key.trim().toLowerCase());
  if (!real) {
    const known = (table.columns ?? []).map((c) => c.field).join(', ');
    throw new CommandletError(`"${table.name}" has no column "${key}"${known ? ` — it has ${known}` : ''}.`);
  }
  return real;
}

// -- search / view / cmd ------------------------------------------------------

function runSearch(cmd: Commandlet): void {
  const query = cmd.targets[0] ?? '';
  // The header box owns the global query, so tell it rather than broadcasting
  // behind its back — otherwise rows narrow while the box still looks empty.
  document.dispatchEvent(new CustomEvent('easydb:set-search', { detail: { query } }));
}

async function runView(cmd: Commandlet): Promise<void> {
  const match = await findViewByName(cmd.targets[0] ?? '');
  await revealViewWindow(match.id);
}

async function runCommandId(cmd: Commandlet): Promise<void> {
  const spec = await findCommandById(cmd.targets[0] ?? '');
  const app = await getContext();
  await spec.run(app.api);
}

async function findViewByName(rawName: string): Promise<ViewInstance> {
  const name = rawName.trim();
  const app = await getContext();
  const instances = (await app.store.viewInstances.find()).filter((v) => v.workspaceId === app.workspaceId);
  const match = instances.find((v) => v.name === name) ?? instances.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new CommandletError(`No view called "${name}".`);
  return match;
}

async function findCommandById(id: string): Promise<CommandSpec> {
  const app = await getContext();
  const spec = app.registries.commands.find((c) => c.id === id) ?? app.registries.commands.find((c) => c.id.toLowerCase() === id.toLowerCase());
  if (!spec) throw new CommandletError(`No command with id "${id}".`);
  return spec;
}

// -- lookup -------------------------------------------------------------------

/**
 * Tables are addressed BY NAME, like projections and view instances — a table
 * deleted and re-imported keeps its name but gets a new id, and a commandlet in
 * a bookmark has to survive that.
 */
async function findTableByName(name: string): Promise<Table> {
  const wanted = name.trim();
  if (!wanted) throw new CommandletError('No table name given.');
  const app = await getContext();
  const tables = (await app.store.tables.find()).filter((t) => t.workspaceId === app.workspaceId);
  const match = tables.find((t) => t.name === wanted) ?? tables.find((t) => t.name.toLowerCase() === wanted.toLowerCase());
  if (!match) throw new CommandletError(`No table called "${wanted}".`);
  return match;
}
