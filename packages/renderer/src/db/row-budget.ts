// packages/renderer/src/db/row-budget.ts
//
// **A workspace in the browser holds 10,000 rows. Past that the app says no.**
//
// One number, and it is a refusal rather than a warning, because the alternative
// was measured and it is not a matter of taste. In IndexedDB, on this app's row
// layout (see `.claude/plans/2026-08-13-sqlite-threshold.md`):
//
//   rows    import        count()   filter    funnel list
//   20 000  5.8 s         575 ms    1.6 s     496 ms
//   60 000  135 s         3.5 s     3.2 s     2.0 s
//   120 000 320 s         5.3 s     5.9 s     4.1 s
//
// The same table in a `.edb` (SQLite in a Worker): 12 s to import 120 000, a
// count in 17 ms, a filter in 180 ms. Nothing in that column grows.
//
// 10 000 is deliberately PESSIMISTIC — below every crossing point rather than at
// one. At 10 000 a filter lands in about 0.8 s and everything else inside a
// quarter of a second, so a workspace that is allowed to exist is one that feels
// quick. The first thing to go over budget is the per-column filter at about
// 12 000 rows, so a limit of 10 000 leaves a margin instead of aiming at the
// cliff. It is also a number a person can remember, which a threshold nobody can
// recite is not.
//
// **Counted per WORKSPACE, not per table**, because that is what the measurements
// say. Dexie keeps every table of every workspace in one `rows` store keyed by a
// random UUID, so an insert degrades against everything already in it: the same
// 20 000-row chunk took 5.8 s into an empty store and 34 s with 20 000 rows
// already there. Twenty tables of 10 000 rows would be the same hole as one table
// of 200 000, so a per-table limit would not hold the line it claims to.
//
// What is NOT limited: reading, editing and deleting (a workspace that is already
// too big must not become unusable — only unable to grow), any `.edb` workspace,
// the whole Electron app (its store is SQLite at every size), and rows that live
// in a provider rather than the store (Datasette, a projection).

import type { Table as DexieTable } from 'dexie';
import type { Row, Table } from '@easydb/shared';

/** The number. Ten thousand rows per browser workspace. */
export const BROWSER_ROW_LIMIT = 10_000;

/**
 * Test seam. Two e2e specs exist to prove the grid's 20 000-row read cap behaves,
 * and they seed the store directly — a fixture, not a user action. Nothing in the
 * app's own UI sets this, so the limit stays a refusal for everybody who did not
 * go looking for it.
 */
function limit(): number {
  const raw = (globalThis as { __easydbRowLimit?: unknown }).__easydbRowLimit;
  return typeof raw === 'number' && raw > 0 ? raw : BROWSER_ROW_LIMIT;
}

/**
 * Is this tab even subject to the limit?
 *
 * True only where the Dexie store was built — not in Electron, not in a `.edb`
 * session. Set by `createDataStore` rather than sniffed from the environment,
 * because the store that was actually constructed is the fact that matters.
 *
 * Needed because of the PRE-FLIGHTS below: the enforcement in the rows view runs
 * inside the Dexie store and cannot be wrong about this, but a caller asking "will
 * this import fit" is store-agnostic and must not refuse a 40 000-row pull into a
 * file-backed workspace.
 */
let browserStore = false;

export function markBrowserStore(): void {
  browserStore = true;
}

export function browserRowLimitApplies(): boolean {
  return browserStore;
}

/** Test seam: the flag is set by construction, so a test has to say it either way. */
export function __setBrowserStore(on: boolean): void {
  browserStore = on;
}

/**
 * Refuse an import BEFORE it deletes anything, when the incoming rows cannot fit
 * whatever it leaves behind.
 *
 * This exists because three callers wipe first and write second — a sync pull, a
 * gist pull and a "replace entire workspace" JSON import all clear the workspace
 * and then insert. Left to the store-level check, the insert is refused half way
 * and the user is left with the old workspace deleted and part of a new one. So a
 * whole-workspace write asks first, while there is still nothing to lose.
 *
 * Only the incoming total is judged. Anything a wipe frees is free by then, and an
 * import small enough to fit after the wipe is exactly the case that must still be
 * allowed.
 */
export function assertIncomingFits(incoming: number): void {
  if (!browserStore) return;
  const max = limit();
  if (incoming > max) throw new RowLimitError(0, incoming, max);
}

/** Thrown by a write that would take a browser workspace over the limit. */
export class RowLimitError extends Error {
  readonly used: number;
  readonly incoming: number;
  readonly max: number;
  constructor(used: number, incoming: number, max: number) {
    super(rowLimitMessage(used, incoming, max));
    this.name = 'RowLimitError';
    this.used = used;
    this.incoming = incoming;
    this.max = max;
  }
}

/**
 * What the user is told: the number, then their situation, then the way out.
 *
 * Three short sentences, because this arrives as a TOAST from whichever importer
 * was refused, and the way out has to be a place they can go rather than a
 * concept. `File → New .edb file…` copies the workspace it is in, so it is both
 * the escape and the migration.
 */
export function rowLimitMessage(used: number, incoming: number, max: number): string {
  return (
    `A workspace in this browser holds ${max.toLocaleString()} rows. This would make ${(used + incoming).toLocaleString()}. ` +
    `Keep data this size in a file instead — the footer's File → New .edb file… copies this workspace into one, with no row limit and about 25× the speed.`
  );
}

/**
 * How many rows the workspace holds, counted no further than it has to be.
 *
 * `limit + 1` keys is the whole read: the answer is only ever compared against the
 * limit, so a workspace of 600 000 rows costs the same walk as one of 10 001. It
 * matters because counting in IndexedDB walks the index — 14 s on 609 283 rows —
 * and this runs on the write path.
 */
async function countUpTo(rows: DexieTable<Row, string>, tableIds: readonly string[], cap: number): Promise<number> {
  if (tableIds.length === 0) return 0;
  const keys = await rows
    .where('tableId')
    .anyOf(tableIds as string[])
    .limit(cap + 1)
    .primaryKeys();
  return keys.length;
}

/**
 * Cached per workspace, because the check runs on every insert and a walk of
 * 10 000 keys per typed row would be its own performance bug.
 *
 * Kept honest in the direction that matters: the total is INCREASED on a write and
 * never decreased, so it can only ever be too high — and a check that is about to
 * REFUSE recounts first. So a stale total delays a refusal by one recount and can
 * never cause one. (Deletes, another tab and a sync pull are all why it drifts.)
 */
const used = new Map<string, number>();

/** Forget what is cached — a workspace switch, a delete, a test. */
export function forgetRowBudget(workspaceId?: string): void {
  if (workspaceId === undefined) used.clear();
  else used.delete(workspaceId);
}

/** The workspace a table belongs to, or null when the table is unknown. */
async function workspaceOf(tables: DexieTable<Table, string>, tableId: string): Promise<string | null> {
  const table = await tables.get(tableId);
  return table?.workspaceId ?? null;
}

async function tableIdsOf(tables: DexieTable<Table, string>, workspaceId: string): Promise<string[]> {
  const all = await tables.where('workspaceId').equals(workspaceId).primaryKeys();
  return all as string[];
}

/**
 * Refuse a write that would take this workspace over the limit.
 *
 * Called before the rows are written, so a refused import leaves nothing behind —
 * every importer writes in chunks through `bulkInsert`, and the first chunk is
 * turned away whole.
 */
export async function assertRoomForRows(rows: DexieTable<Row, string>, tables: DexieTable<Table, string>, tableId: string, incoming: number): Promise<void> {
  if (incoming <= 0) return;
  const max = limit();
  const workspaceId = await workspaceOf(tables, tableId);
  // A table with no record yet cannot be attributed to a workspace. Let it
  // through: the alternative is refusing the first write of a legitimate import
  // whose table row has not landed, and the next write will be counted.
  if (workspaceId === null) return;

  const cached = used.get(workspaceId);
  if (cached !== undefined && cached + incoming <= max) {
    used.set(workspaceId, cached + incoming);
    return;
  }

  // Either nothing is cached, or the cached total says no. Measure before
  // refusing: a cached total is never too low, so this is the only place a wrong
  // answer could cost the user a write they should have had.
  const measured = await countUpTo(rows, await tableIdsOf(tables, workspaceId), max);
  if (measured + incoming > max) {
    used.set(workspaceId, measured);
    throw new RowLimitError(measured, incoming, max);
  }
  used.set(workspaceId, measured + incoming);
}
