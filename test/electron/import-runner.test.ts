import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SqliteStore } from '../../packages/electron/src/sqlite-store.js';
import { prepareImport } from '../../packages/electron/src/db-import.js';
import { canUseWorker, runImport } from '../../packages/electron/src/import-runner.js';

/**
 * The row copy runs on a worker thread so the main thread stops blocking on
 * synchronous SQLite writes. What matters here is that delegating changes
 * NOTHING about the result: the same rows, the same values, progress reported the
 * same way — and that a file which refused WAL still imports, in-process.
 *
 * These drive the real worker, so they need the compiled `dist/import-worker.js`;
 * `canUseWorker` reports whether it is there, and the "same data" assertions hold
 * on either path.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

let dir: string;
let sourcePath: string;
let destPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-runner-'));
  sourcePath = join(dir, 'source.db');
  destPath = join(dir, 'dest.db');

  const raw = new DatabaseSync(sourcePath);
  raw.exec(`CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER)`);
  const stmt = raw.prepare(`INSERT INTO widgets (name, qty) VALUES (?, ?)`);
  for (let i = 0; i < 1500; i++) stmt.run(`w${i}`, i);
  raw.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A prepared (structure-only) target plus the one entry to fill. */
function prepared(): { store: SqliteStore; entry: ReturnType<typeof prepareImport>['plan'][number] } {
  const store = new SqliteStore({ path: destPath });
  store.insert('workspaces', { id: 'ws', name: 'ws', createdAt: 1, pluginUrls: [] });
  const { plan } = prepareImport(sourcePath, store, 'ws', {});
  const entry = plan[0];
  if (!entry) throw new Error('nothing to import');
  return { store, entry };
}

describe('runImport', () => {
  it('WAL is on, so the worker is the path taken', () => {
    const store = new SqliteStore({ path: destPath });
    try {
      // WAL is the precondition for a second connection writing this file.
      expect(store.journalMode()).toBe('wal');
    } finally {
      store.close();
    }
  });

  it('copies every row, with values intact', async () => {
    const { store, entry } = prepared();
    try {
      const rows = await runImport(sourcePath, store, entry, { onProgress: () => undefined });

      expect(rows).toBe(1500);
      const got = store.find('rows', { tableId: entry.tableId }) as Array<{ data: Record<string, unknown> }>;
      expect(got).toHaveLength(1500);
      const byName = new Map(got.map((r) => [r.data.name, r.data.qty]));
      expect(byName.get('w0')).toBe(0);
      expect(byName.get('w1499')).toBe(1499);
    } finally {
      store.close();
    }
  });

  it('reports progress that climbs to the total', async () => {
    const { store, entry } = prepared();
    try {
      const seen: number[] = [];
      await runImport(sourcePath, store, entry, { onProgress: (p) => seen.push(p.rows) });

      expect(seen.length).toBeGreaterThan(1); // batched, not one lump
      expect(seen.at(-1)).toBe(1500);
      // Monotonic — a progress bar must never go backwards.
      for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
    } finally {
      store.close();
    }
  });

  it('the rows are in the .db itself, not stranded in the -wal sidecar', async () => {
    const { store, entry } = prepared();
    try {
      await runImport(sourcePath, store, entry, { onProgress: () => undefined });
      store.checkpoint();
      // A SEPARATE read-only connection sees them, which a copy (Save As) needs.
      const check = new DatabaseSync(destPath, { readOnly: true });
      try {
        const n = check.prepare(`SELECT COUNT(*) AS n FROM ${JSON.stringify(entry.sqlTable)}`).get() as { n: number };
        expect(n.n).toBe(1500);
      } finally {
        check.close();
      }
    } finally {
      store.close();
    }
  });

  it('stops when cancelled, keeping what already landed', async () => {
    const { store, entry } = prepared();
    try {
      let seen = 0;
      const rows = await runImport(sourcePath, store, entry, {
        onProgress: (p) => (seen = p.rows),
        // Cancel as soon as anything has been written.
        isCancelled: () => seen > 0,
      });
      expect(rows).toBeGreaterThan(0);
      expect(rows).toBeLessThanOrEqual(1500);
    } finally {
      store.close();
    }
  });

  it('takes the worker path when WAL is on and the built worker is present', () => {
    const store = new SqliteStore({ path: destPath });
    try {
      // Guards the resolution bug this test caught once already: `__dirname` under
      // vitest points at src/, so a worker looked up only as a sibling is missing
      // and every "worker" test quietly runs the in-process fallback instead.
      expect(store.journalMode()).toBe('wal');
      expect(canUseWorker(store)).toBe(true);
    } finally {
      store.close();
    }
  });

  /**
   * The whole point of the worker: the MAIN thread stops blocking.
   *
   * Measured as event-loop lag — a 20ms interval that fires late is a thread that
   * was busy. In-process, synchronous SQLite writes made the main thread 99.7%
   * blocked over a real import, with single stalls over a second. Delegating must
   * keep the lag near zero, and that is what this asserts.
   */
  it('leaves the main thread free while it copies', async () => {
    const { store, entry } = prepared();
    const INTERVAL_MS = 5;
    try {
      const lags: number[] = [];
      let last = Date.now();
      const timer = setInterval(() => {
        const now = Date.now();
        lags.push(now - last - INTERVAL_MS);
        last = now;
      }, INTERVAL_MS);

      await runImport(sourcePath, store, entry, { onProgress: () => undefined });
      clearInterval(timer);

      // Only a guard against `Math.max()` of an empty array. It deliberately does
      // NOT require a minimum number of samples: how many land depends on how long
      // the copy happens to take, and an earlier version asserting `> 2` failed
      // about one run in three purely because the import finished quickly — which
      // is the good outcome, not a regression.
      expect(lags.length).toBeGreaterThanOrEqual(1);
      const worst = Math.max(...lags);
      // The actual claim. Generous next to the ~1300ms stalls the in-process path
      // produced, while still far below anything a person notices.
      expect(worst).toBeLessThan(150);
    } finally {
      store.close();
    }
  });
});
