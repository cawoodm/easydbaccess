// packages/renderer/src/plugins/commandlet-run.ts
//
// Runs what `commandlet-lang.ts` parsed. Every effect here already exists
// somewhere in the app; this module only routes to it:
//   - filters and sort are a patch of `Table.filters` / `sortBy`, which
//     `data-table.applyTable()` re-reads on its own subscription,
//   - windows come from `focusTableWindow` / `revealViewWindow`,
//   - search rides the `easydb:table-search` / `easydb:set-search` events,
//   - `cmd/` looks up the id in `registries.commands`.

import type { SortSpec, Table } from '@easydb/shared';
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
  for (const [field, expr] of Object.entries(cmd.filters)) {
    // An empty value is how a commandlet REMOVES a filter, so a link can widen a
    // view as well as narrow it.
    if (expr === '') delete merged[field];
    else merged[field] = expr;
  }
  if (Object.keys(cmd.filters).length > 0 || cmd.options.clear !== undefined) {
    patch.filters = Object.keys(merged).length > 0 ? merged : undefined;
  }

  const sort = parseSort(cmd.options.sort);
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
function parseSort(spec: string | undefined): SortSpec[] | null {
  if (spec === undefined) return null;
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith('-') ? { field: s.slice(1), asc: false } : { field: s, asc: true }));
}

// -- search / view / cmd ------------------------------------------------------

function runSearch(cmd: Commandlet): void {
  const query = cmd.targets[0] ?? '';
  // The header box owns the global query, so tell it rather than broadcasting
  // behind its back — otherwise rows narrow while the box still looks empty.
  document.dispatchEvent(new CustomEvent('easydb:set-search', { detail: { query } }));
}

async function runView(cmd: Commandlet): Promise<void> {
  const name = (cmd.targets[0] ?? '').trim();
  const app = await getContext();
  const instances = (await app.store.viewInstances.find()).filter((v) => v.workspaceId === app.workspaceId);
  const match = instances.find((v) => v.name === name) ?? instances.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (!match) throw new CommandletError(`No view called "${name}".`);
  await revealViewWindow(match.id);
}

async function runCommandId(cmd: Commandlet): Promise<void> {
  const id = cmd.targets[0] ?? '';
  const app = await getContext();
  const spec = app.registries.commands.find((c) => c.id === id) ?? app.registries.commands.find((c) => c.id.toLowerCase() === id.toLowerCase());
  if (!spec) throw new CommandletError(`No command with id "${id}".`);
  await spec.run(app.api);
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
