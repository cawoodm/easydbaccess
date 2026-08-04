import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { SqliteStore } from '../../packages/electron/src/sqlite-store.js';
import { commitImport } from '../../packages/electron/src/db-import.js';

/**
 * Importing a big table must STREAM, not materialise.
 *
 * Regression test for a real hang: converting a 609,283-row `northwind.db`
 * drove the Electron main process past 1.4 GB and froze the window, because the
 * import read every row of a table into one array before inserting any — which
 * defeated `readRowBatches`, the generator whose whole stated purpose is "so a
 * large table is never fully materialised".
 *
 * The observable that separates the two designs is the heap AT THE MOMENT OF
 * THE FIRST INSERT: streaming has one batch alive, accumulating has the whole
 * table. Row counts and call counts look identical either way, so they cannot
 * catch this.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** Enough rows that accumulating them is unmistakable in the heap, few enough to stay fast. */
const ROWS = 150_000;

let dir: string;
let sourcePath: string;
let targetPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-import-stream-'));
  sourcePath = join(dir, 'source.db');
  targetPath = join(dir, 'target.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function buildBigSource(): void {
  const db = new DatabaseSync(sourcePath);
  db.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, label TEXT, n INTEGER)');
  db.exec('BEGIN');
  const insert = db.prepare('INSERT INTO big (label, n) VALUES (?, ?)');
  for (let i = 0; i < ROWS; i++) insert.run(`row-${i}-with-some-payload-text`, i);
  db.exec('COMMIT');
  db.close();
}

/**
 * Wraps a real store, sampling the heap on the first `bulkInsert` — that is when
 * a streaming import has read one batch and an accumulating one has read
 * everything.
 */
function watchFirstInsert(store: SqliteStore): { heapAtFirstInsert: () => number | null } {
  let sampled: number | null = null;
  const original = store.bulkInsert.bind(store);
  store.bulkInsert = (coll: string, docs: Record<string, unknown>[]): unknown[] => {
    if (sampled === null && coll === 'rows') {
      global.gc?.();
      sampled = process.memoryUsage().heapUsed;
    }
    return original(coll, docs);
  };
  return { heapAtFirstInsert: () => sampled };
}

describe('commitImport streams a large table instead of materialising it', () => {
  it('has only a batch in memory when the first rows are written', () => {
    buildBigSource();
    const target = new SqliteStore({ path: targetPath });
    const watch = watchFirstInsert(target);

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const results = commitImport(sourcePath, target, 'ws1', {});
    const atFirst = watch.heapAtFirstInsert();
    target.close();

    expect(results[0]).toMatchObject({ sourceName: 'big', rowCount: ROWS });
    expect(atFirst).not.toBeNull();

    const grewByMb = (atFirst! - before) / (1024 * 1024);
    // Accumulating 150k rows costs well over 100 MB before the first write;
    // streaming holds 500 docs, a rounding error. The bound is deliberately
    // loose — it is there to catch materialisation, not to police allocation.
    expect(grewByMb).toBeLessThan(50);
  });

  it('still imports every row, in order, with the values intact', () => {
    buildBigSource();
    const target = new SqliteStore({ path: targetPath });
    const results = commitImport(sourcePath, target, 'ws1', {});
    const tableId = results[0]!.tableId!;

    expect(target.count('rows')).toBe(ROWS);
    const rows = target.find('rows', { tableId }) as Array<{ data: Record<string, unknown> }>;
    expect(rows[0]!.data).toEqual({ id: 1, label: 'row-0-with-some-payload-text', n: 0 });
    expect(rows[ROWS - 1]!.data.n).toBe(ROWS - 1);
    target.close();
  });
});
