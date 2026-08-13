// packages/renderer/src/table/validate-scan.ts
//
// Read a whole table past the validator, a page at a time.
//
// Why a page at a time when the rules are checked in the renderer anyway: a
// 609,283-row table read as one array is 21 s of nothing on screen and a copy of
// the table in memory. Paging gives the loop somewhere to report progress from,
// somewhere to notice a cancel, and a point to hand the thread back to the
// browser so the app stays alive while it runs.
//
// One thing this deliberately does NOT do: push `notnull` / `max` / `unique` down
// to the store as SQL. The design sketch called for that, and it would work on the
// SQLite stores — but the browser's IndexedDB has no index on a field inside
// `data`, so there is nothing there to push to and every rule costs a full read
// regardless. A second code path that only ever helped the desktop is not worth
// two definitions of `max`. See `docs/tech/DATA-TABLE.md`.

import type { DataCollection, Row } from '@easydb/shared';
import { createValidator, type RowIssue, type ValidatorOptions } from './validate-rules.js';
import type { ColumnSpec } from '@easydb/shared';

/** Rows per read. Big enough to be one cheap query, small enough to yield often. */
export const SCAN_PAGE_ROWS = 2_000;

export interface ScanOptions extends ValidatorOptions {
  /** Rows per page. */
  pageRows?: number;
  /** Told how many rows have been checked, and out of how many if known. */
  onProgress?: (scanned: number, total: number) => void;
  /** Asked between pages. True ⇒ stop and report what was found so far. */
  cancelled?: () => boolean;
}

export interface ScanResult {
  issues: RowIssue[];
  /** Rows actually checked — less than the table when cancelled. */
  scanned: number;
  /** Issues the per-column cap left out, by column label. */
  capped: Map<string, number>;
  cancelled: boolean;
  /** No column carries a rule, so nothing was read at all. */
  noRules: boolean;
}

/** Hand the thread back, so a scan of 600,000 rows does not freeze the tab. */
function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Check every row of `coll` against `columns`.
 *
 * Returns early — reading nothing — when no column carries a rule. That is the
 * common case for a big imported table, and it makes the button honest: pressing
 * it on a table with no rules costs one lookup, not a scan.
 */
export async function scanTable(coll: DataCollection<Row>, columns: readonly ColumnSpec[], opts: ScanOptions = {}): Promise<ScanResult> {
  const validator = createValidator(columns, opts);
  if (validator.fields.length === 0) {
    return { issues: [], scanned: 0, capped: new Map(), cancelled: false, noRules: true };
  }

  const pageRows = opts.pageRows ?? SCAN_PAGE_ROWS;
  const issues: RowIssue[] = [];
  let scanned = 0;
  let cancelled = false;

  // The count is what makes the progress bar determinate. It is optional on the
  // contract, and on a big IndexedDB table it costs seconds — but this scan is
  // going to read every row anyway, so the count is a rounding error here.
  const total = coll.count ? await coll.count() : 0;
  opts.onProgress?.(0, total);

  /** Run the validator over one batch, and report. Returns false to stop. */
  const takeBatch = async (rows: readonly Row[]): Promise<boolean> => {
    for (const row of rows) {
      issues.push(...validator.check(row, scanned));
      scanned++;
    }
    opts.onProgress?.(scanned, total);
    if (opts.cancelled?.()) {
      cancelled = true;
      return false;
    }
    await breathe();
    return true;
  };

  if (coll.query) {
    for (let offset = 0; ; offset += pageRows) {
      // `countTotal: false` — the total came from `count()` above, and asking each
      // page to count the table again would pay for it once per page.
      const page = await coll.query({ offset, limit: pageRows, countTotal: false });
      if (page.rows.length === 0) break;
      if (!(await takeBatch(page.rows))) break;
      if (page.rows.length < pageRows) break;
    }
  } else {
    // No windowed read on this collection: one array, chunked here so the loop
    // still yields and can still be cancelled.
    const all = await coll.find();
    opts.onProgress?.(0, all.length);
    for (let from = 0; from < all.length; from += pageRows) {
      if (!(await takeBatch(all.slice(from, from + pageRows)))) break;
    }
  }

  return { issues, scanned, capped: validator.capped(), cancelled, noRules: false };
}
