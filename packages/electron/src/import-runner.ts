/**
 * Runs one table's row copy on a worker thread, falling back to this thread when
 * a worker isn't usable.
 *
 * The fallback is not decoration. A worker can only write the same file
 * concurrently in WAL mode, and WAL cannot always be set — a database on
 * read-only media, or one another tool has open in a mode that refuses the
 * conversion, keeps its rollback journal. Writing from two connections then means
 * a whole-database lock, so the import would be slower AND still block the main
 * thread. Checking first and staying in-process is the honest answer; the import
 * behaves exactly as it did before the worker existed.
 */

import * as path from 'node:path';
import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { SqliteStore } from './sqlite-store';
import { importRowsFor, type ImportPlanEntry, type ImportProgress } from './db-import';
import type { ImportWorkerJob, ImportWorkerMessage } from './import-worker';

/**
 * The COMPILED worker entry. A `Worker` needs JavaScript on disk, so this can
 * never be the `.ts` beside this file.
 *
 * Two locations because this module runs from two places: from `dist/` in the
 * app, where the worker is its sibling, and from `src/` under vitest, which
 * transpiles TypeScript in memory and leaves `__dirname` pointing at the source
 * tree. Without the second candidate the tests silently exercised the in-process
 * fallback while appearing to cover the worker.
 */
function workerPath(): string {
  const sibling = path.join(__dirname, 'import-worker.js');
  if (existsSync(sibling)) return sibling;
  return path.join(__dirname, '..', 'dist', 'import-worker.js');
}

/** Whether a worker can safely write the store's file alongside the open connection. */
export function canUseWorker(store: SqliteStore): boolean {
  return store.journalMode() === 'wal' && existsSync(workerPath());
}

export interface RunImportOptions {
  onProgress(p: ImportProgress): void;
  /** Resolves truthy to abandon the copy — checked between batches. */
  isCancelled?: () => boolean;
}

/**
 * Copies `entry`'s rows and resolves with how many landed.
 *
 * Prefers a worker thread; on a file that refused WAL, runs here instead,
 * yielding between batches so the event loop still turns.
 */
export function runImport(sourcePath: string, store: SqliteStore, entry: ImportPlanEntry, opts: RunImportOptions): Promise<number> {
  if (canUseWorker(store)) return runInWorker(sourcePath, store, entry, opts);
  return runInProcess(sourcePath, store, entry, opts);
}

function runInWorker(sourcePath: string, store: SqliteStore, entry: ImportPlanEntry, opts: RunImportOptions): Promise<number> {
  const job: ImportWorkerJob = { sourcePath, dbPath: store.filePath, entry };
  return new Promise<number>((resolve, reject) => {
    const worker = new Worker(workerPath(), { workerData: job });
    let rows = 0;
    let settled = false;
    /**
     * Settle only once the thread is really gone.
     *
     * `terminate()` is asynchronous, and until it resolves the worker still holds
     * its SQLite connection — so resolving first let the caller carry on while the
     * file was still open. That surfaced as an EPERM deleting the database, and
     * would surface in the app as the next import contending with a thread nobody
     * is waiting for any more.
     */
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate().then(fn, fn);
    };

    // Cancellation kills the thread. Its transaction is per batch, so what has
    // been committed stays and the rest simply never happens — the caller
    // reports the table as partly filled.
    const cancelTimer = opts.isCancelled
      ? setInterval(() => {
          if (opts.isCancelled?.()) finish(() => resolve(rows));
        }, 200)
      : null;
    const stopTimer = (): void => {
      if (cancelTimer) clearInterval(cancelTimer);
    };

    worker.on('message', (msg: ImportWorkerMessage) => {
      if (msg.kind === 'progress') {
        rows = msg.rows;
        opts.onProgress({ table: msg.table, rows: msg.rows, total: msg.total });
        return;
      }
      stopTimer();
      if (msg.kind === 'done') finish(() => resolve(msg.rows));
      else finish(() => reject(new Error(msg.message)));
    });
    worker.on('error', (err) => {
      stopTimer();
      finish(() => reject(err));
    });
    worker.on('exit', (code) => {
      stopTimer();
      // Only reached when no 'done'/'error' arrived — a crashed or terminated
      // thread. Resolving with what landed beats hanging the caller forever.
      if (!settled) {
        settled = true;
        if (code === 0) resolve(rows);
        else reject(new Error(`import worker exited with code ${code}`));
      }
    });
  });
}

/**
 * The pre-worker path, kept for files that refused WAL. `setImmediate` between
 * batches is what lets the event loop turn at all here; combined with the
 * time-boxed batches it bounds a single block at tens of milliseconds rather than
 * removing it.
 */
async function runInProcess(sourcePath: string, store: SqliteStore, entry: ImportPlanEntry, opts: RunImportOptions): Promise<number> {
  store.setDurability('bulk');
  try {
    let rows = 0;
    for (const p of importRowsFor(sourcePath, store, entry)) {
      rows = p.rows;
      opts.onProgress(p);
      if (opts.isCancelled?.()) return rows;
      await new Promise((resolve) => setImmediate(resolve));
    }
    return rows;
  } finally {
    store.setDurability('safe');
  }
}
