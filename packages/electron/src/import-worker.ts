/**
 * Import worker — copies ONE table's rows on a thread of its own.
 *
 * `node:sqlite` is synchronous, so whichever thread writes a batch is blocked
 * for its duration. Running that on the main thread blocked the thread answering
 * the renderer's `store:*` IPC: measured over a `northwind.db` import, 99.7% duty
 * cycle, median 127ms per block and worst 1344ms, so every click and every
 * subscription re-read queued behind it. Time-boxing the batches
 * (`db-import.ts`'s `BatchPacer`) capped a single block at ~72ms, but the main
 * thread was still doing all the work. Here it does none of it.
 *
 * This thread opens its OWN connection to the target file. That is only safe in
 * WAL mode, where one writer and many readers coexist — under the default
 * rollback journal a writer locks the whole database and the main connection
 * would block exactly as before. `sqlite-store.ts`'s `tune()` sets WAL, and
 * `import-runner.ts` checks it actually took before choosing this path.
 *
 * Messages out are `{ kind: 'progress' | 'done' | 'error' }`; the runner turns
 * them back into the same `ImportProgress` stream the in-process path emits, so
 * nothing downstream can tell which one ran.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { SqliteStore } from './sqlite-store';
import { importRowsFor, type ImportPlanEntry } from './db-import';

export interface ImportWorkerJob {
  /** The foreign or easydb file being read. */
  sourcePath: string;
  /** The workspace file being written — the same one the main process has open. */
  dbPath: string;
  entry: ImportPlanEntry;
}

export type ImportWorkerMessage = { kind: 'progress'; table: string; rows: number; total: number } | { kind: 'done'; rows: number } | { kind: 'error'; message: string };

/** Runs the job described by `workerData` and reports back over `parentPort`. */
function run(): void {
  if (!parentPort) throw new Error('import-worker: not running as a worker');
  const port = parentPort;
  const job = workerData as ImportWorkerJob;

  const store = new SqliteStore({ path: job.dbPath });
  try {
    // Same trade as the in-process path: durability off for the length of a bulk
    // copy. A crash mid-import is already something the user must redo, and this
    // thread owns nothing else.
    store.setDurability('bulk');
    let rows = 0;
    for (const p of importRowsFor(job.sourcePath, store, job.entry)) {
      rows = p.rows;
      const msg: ImportWorkerMessage = { kind: 'progress', table: p.table, rows: p.rows, total: p.total };
      port.postMessage(msg);
    }
    store.setDurability('safe');
    // Fold the sidecar back in so the rows are in the `.db` itself: the main
    // connection reads them either way, but a copy (Save As) only takes the
    // `.db`, and nothing guarantees this thread outlives the next one.
    store.checkpoint();
    const done: ImportWorkerMessage = { kind: 'done', rows };
    port.postMessage(done);
  } catch (err) {
    const msg: ImportWorkerMessage = {
      kind: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    port.postMessage(msg);
  } finally {
    store.close();
  }
}

run();
