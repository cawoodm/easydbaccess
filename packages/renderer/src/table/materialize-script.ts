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
// so the rules below are unit-testable without Dexie.

import type { DataCollection, Row } from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';

export interface MaterializeResult {
  /** Cells whose stored value changed. */
  written: number;
  /** Rows the script produced the value already there for. */
  unchanged: number;
  /** Rows the script threw on. Their cells are untouched. */
  failed: number;
  /** The first failure's message, for a report the user can act on. */
  firstError: string | null;
}

/** Rows written per await, so a long run yields to the UI between batches. */
const CHUNK = 200;

/**
 * Write `render(row)` into `field` for each of `targets`.
 *
 * A row the script throws on is COUNTED AND SKIPPED rather than aborting the
 * run: a script that copes with 99% of the data is the normal case for a
 * one-off, and stopping at the first bad row would leave the column half
 * written with no way to tell where it stopped. The caller reports the tally.
 *
 * A row whose value is already what the script returns is not patched — the
 * common case of re-running is then free, and it keeps `updatedAt` (and any
 * sync that reads it) honest about what actually changed.
 */
export async function materializeColumnScript(
  rows: DataCollection<Row>,
  source: string,
  field: string,
  targets: readonly Row[],
  onProgress?: (done: number, total: number) => void,
): Promise<MaterializeResult> {
  const result: MaterializeResult = { written: 0, unchanged: 0, failed: 0, firstError: null };
  const total = targets.length;
  for (let i = 0; i < total; i++) {
    const row = targets[i];
    if (!row) continue;
    const run = runColumnScript(source, row.data);
    if (!run.ok) {
      result.failed++;
      result.firstError ??= run.message || run.label;
      continue;
    }
    if (sameCell(row.data[field], run.value)) {
      result.unchanged++;
    } else {
      await rows.patch(row.id, { data: { ...row.data, [field]: run.value as never } });
      result.written++;
    }
    if ((i + 1) % CHUNK === 0) {
      onProgress?.(i + 1, total);
      // Hand the frame back: a 20 000-row run would otherwise freeze the tab.
      await Promise.resolve();
    }
  }
  onProgress?.(total, total);
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
export function materializeSummary(r: MaterializeResult, field: string): string {
  const parts = [`${r.written.toLocaleString()} ${r.written === 1 ? 'cell' : 'cells'} written to “${field}”`];
  if (r.unchanged > 0) parts.push(`${r.unchanged.toLocaleString()} already correct`);
  if (r.failed > 0) parts.push(`${r.failed.toLocaleString()} failed — ${r.firstError ?? 'the script threw'}`);
  return `${parts.join(', ')}.`;
}
