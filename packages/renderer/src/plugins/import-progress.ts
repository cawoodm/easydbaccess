/**
 * Overall progress of a multi-table import, weighted by how big each table is.
 *
 * Per-table progress already shows in each window's titlebar, but during a
 * convert every window is minimized, so the only thing a user can watch is a row
 * counter in the dock — and a counter per table says nothing about how far
 * through the FILE they are.
 *
 * Weighted, not per-table, because the tables are wildly uneven. Converting
 * `northwind.db` means 13 tables of which three hold 609,283 rows each and the
 * rest hold dozens; a bar that gave each table 1/13th would sit at 8% for most
 * of a minute and then sprint. Row count is the weight because it is what the
 * time is spent on — a row is a decode, an encode and an insert regardless of
 * which table it is in.
 *
 * Pure and DOM-free: the caller decides where the number is shown.
 */

/** One table the import will fill, and how much work it is. */
export interface ImportWorkItem {
  tableId: string;
  /** Rows to be written. May be 0 for an empty table, or for an unknown count. */
  total: number;
}

export class ImportProgress {
  private readonly weight = new Map<string, number>();
  /** Rows written so far per table, capped at that table's weight. */
  private readonly done = new Map<string, number>();
  private readonly totalWeight: number;
  /**
   * True when no table declared a row count, so there is nothing to weigh by
   * and each table counts for one. Without this the bar would sit at zero for
   * the whole run and then jump to done.
   */
  private readonly uniform: boolean;

  constructor(items: readonly ImportWorkItem[]) {
    const declared = items.reduce((n, i) => n + Math.max(0, i.total), 0);
    this.uniform = declared === 0;
    for (const i of items) this.weight.set(i.tableId, this.uniform ? 1 : Math.max(0, i.total));
    this.totalWeight = this.uniform ? items.length : declared;
  }

  /** Rows written so far in one table. Ignores an id that is not in the plan. */
  observe(tableId: string, rows: number): void {
    const w = this.weight.get(tableId);
    if (w == null) return;
    // Capped: a table can report more rows than its planned total (a count is a
    // snapshot, and an append writes into a table that already had rows), and an
    // overshoot must not push the bar past 100%.
    this.done.set(tableId, Math.min(w, Math.max(0, rows)));
  }

  /**
   * This table is finished, whatever its counter last said.
   *
   * Needed as well as `observe` because a table's final batch is not guaranteed
   * to report the exact planned total — the count came from a separate query, and
   * a table with fewer rows than planned would otherwise leave the bar short of
   * 100% for the rest of the run.
   */
  complete(tableId: string): void {
    const w = this.weight.get(tableId);
    if (w == null) return;
    this.done.set(tableId, w);
  }

  /** Overall progress, 0..1. Returns 1 for an empty plan — there is no work left. */
  fraction(): number {
    if (this.totalWeight <= 0) return 1;
    let sum = 0;
    for (const v of this.done.values()) sum += v;
    return Math.min(1, sum / this.totalWeight);
  }

  /** Tables finished, for a "3 of 13 tables" label. */
  completedTables(): number {
    let n = 0;
    for (const [id, w] of this.weight) if ((this.done.get(id) ?? -1) >= w) n++;
    return n;
  }

  get tableCount(): number {
    return this.weight.size;
  }
}
