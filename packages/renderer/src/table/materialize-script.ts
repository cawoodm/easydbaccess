// packages/renderer/src/table/materialize-script.ts
//
// Run a column's `render(row)` script over rows and WRITE what it returns into
// the cells.
//
// The everyday behaviour of a column script is to compute a value on the way to
// the renderer and leave the stored cell alone (`util/column-script.ts`), which
// is what keeps a scripted column consistent when its inputs change. This is the
// deliberate opposite: a one-off that turns the computed value into data, so it
// can be exported, synced, filtered and edited like any other column.
//
// Store-shaped but not store-bound — it takes the row collection as an argument,
// so the rules below are unit-testable without a store.

import type { DataCollection, Row } from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';

/**
 * What the app says when it is about to materialize a script that is still
 * LIVE, and both places that can do it ask the same question: the script
 * editor's **Run…** (one column) and the footer's **Run scripts** (several).
 *
 * The wording is shared because it is the one explanation of what an enabled
 * script costs — it recomputes on every draw — and therefore of why a run is
 * usually the moment to park it. Two copies would drift.
 */
export const KEEP_ENABLED_HINT =
  'If you leave the script enabled, it will run continuously. For better performance, disable scripts after you have Run them and loaded data.';

/** The two answers to it. Compared by value, so they live beside the question. */
export const RUN_AND_DISABLE = 'Run and disable';
export const RUN_AND_KEEP = 'Run and keep enabled';

/** What a run DID, with no rows attached — all a report needs. */
export interface MaterializeTally {
  /** Cells whose stored value changed. */
  written: number;
  /** Rows the script produced the value already there for. */
  unchanged: number;
  /** Rows the script threw on. Their cells are untouched. */
  failed: number;
  /** The first failure's message, for a report the user can act on. */
  firstError: string | null;
}

export interface MaterializeResult extends MaterializeTally {
  /**
   * The targets with this run's writes applied, in the order they were given.
   *
   * Here because a caller running SEVERAL columns has to feed each one the
   * result of the last. Running them all from one snapshot wrote the whole row
   * document each time from row data that predated the previous column, so the
   * last column silently undid every column before it — `Run scripts` over two
   * scripted columns left only the second one written.
   */
  rows: Row[];
}

/**
 * Rows per write, so a long run yields to the UI between batches.
 *
 * With `bulkUpdate` this is also the transaction size: one round trip and one
 * change broadcast per batch instead of per row, which is where nearly all of
 * the run's time used to go.
 *
 * Measured over 4 000 rows in the browser store: ~120 s per row, 4.7 s at 200,
 * 2.7 s at 500. What is left is mostly the grid re-reading the table once per
 * broadcast, so a bigger batch keeps paying — but it buys less each time and
 * costs progress granularity, and a batch the grid cannot redraw between is a
 * frozen tab. 500 is where those meet.
 */
const CHUNK = 500;

/**
 * Yield long enough for the browser to paint. `setTimeout` rather than
 * `requestAnimationFrame`, because the unit suites run under plain Node where
 * there are no frames — and a run that never resumes there is worse than one
 * that reports progress a millisecond late.
 */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Write `render(row)` into `field` for each of `targets`.
 *
 * A row the script throws on is COUNTED AND SKIPPED rather than aborting the
 * run: a script that copes with 99% of the data is the normal case for a
 * one-off, and stopping at the first bad row would leave the column half
 * written with no way to tell where it stopped. The caller reports the tally.
 *
 * A row whose value is already what the script returns is not written — the
 * common case of re-running is then free, and it keeps `updatedAt` (and any
 * sync that reads it) honest about what actually changed.
 *
 * Rows are written a BATCH at a time through `bulkUpdate` where the collection
 * has it. A loop of `patch()` costs a round trip, a transaction and a
 * grid-waking change broadcast per row; 4 000 cells took about two minutes that
 * way, nearly all of it that overhead. The per-row path is still here for a
 * collection without `bulkUpdate` (a remote row source, say) — same tallies,
 * same order, just slower.
 */
export async function materializeColumnScript(
  rows: DataCollection<Row>,
  source: string,
  field: string,
  targets: readonly Row[],
  onProgress?: (done: number, total: number) => void,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: 0, unchanged: 0, failed: 0, firstError: null, rows: [] };
  const total = targets.length;
  const bulk = rows.bulkUpdate?.bind(rows);
  let batch: Row[] = [];

  const flush = async (done: number): Promise<void> => {
    if (batch.length > 0) {
      if (bulk) await bulk(batch);
      else for (const row of batch) await rows.patch(row.id, { data: row.data, updatedAt: row.updatedAt });
      result.written += batch.length;
      batch = [];
    }
    onProgress?.(done, total);
    // Hand the frame back: a 20 000-row run would otherwise freeze the tab.
    // A microtask is not enough — it runs before the browser paints, so the
    // progress bar this reports to would not redraw until the run was over.
    if (done < total) await yieldToPaint();
  };

  for (let i = 0; i < total; i++) {
    const row = targets[i];
    if (!row) continue;
    const run = runColumnScript(source, row.data);
    if (!run.ok) {
      result.failed++;
      result.firstError ??= run.message || run.label;
      // Carried out unchanged. Every target comes back, written or not, so the
      // next column sees the whole set and not only the rows this one touched.
      result.rows.push(row);
    } else if (sameCell(row.data[field], run.value)) {
      result.unchanged++;
      result.rows.push(row);
    } else {
      // The whole row, not a patch: `bulkUpdate` replaces the stored document,
      // and the per-row fallback below passes the same object to `patch`.
      //
      // `updatedAt` is bumped because this IS an edit. The old per-row path left
      // it alone — `patch` spreads over the stored doc, and the caller passed
      // only `data` — so a materialized column looked untouched to replication,
      // which settles a row by comparing stamps and would have handed the old
      // values back on the next merge.
      const next: Row = { ...row, data: { ...row.data, [field]: run.value as never }, updatedAt: Date.now() };
      batch.push(next);
      result.rows.push(next);
    }
    if ((i + 1) % CHUNK === 0) await flush(i + 1);
  }
  await flush(total);
  return result;
}

/**
 * Is the computed value already in the cell?
 *
 * Compared loosely on purpose. A script returning `42` for a cell holding the
 * string `'42'` is the ordinary result of typing into a text column, and
 * rewriting every one of those rows would report a change that is not one.
 * Objects and arrays fall back to their JSON, since a script that builds one
 * returns a fresh instance every call.
 */
function sameCell(stored: unknown, computed: unknown): boolean {
  if (stored === computed) return true;
  if (stored == null || computed == null) return stored == null && computed == null;
  if (typeof stored === 'object' || typeof computed === 'object') {
    try {
      return JSON.stringify(stored) === JSON.stringify(computed);
    } catch {
      return false;
    }
  }
  return String(stored) === String(computed);
}

/** One line summarising a run, for the toast. */
export function materializeSummary(r: MaterializeTally, field: string): string {
  const parts = [`${r.written.toLocaleString()} ${r.written === 1 ? 'cell' : 'cells'} written to “${field}”`];
  if (r.unchanged > 0) parts.push(`${r.unchanged.toLocaleString()} already correct`);
  if (r.failed > 0) parts.push(`${r.failed.toLocaleString()} failed — ${r.firstError ?? 'the script threw'}`);
  return `${parts.join(', ')}.`;
}
