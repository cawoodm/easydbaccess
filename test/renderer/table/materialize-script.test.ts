import { describe, expect, it } from 'vitest';
import type { DataCollection, Row } from '../../../packages/shared/src/index.js';
import { materializeColumnScript, materializeSummary } from '../../../packages/renderer/src/table/materialize-script.js';

/** The two methods a materialize run touches; the rest of the contract throws. */
function fakeRows(rows: Row[]): { coll: DataCollection<Row>; patched: Array<{ id: string; data: Record<string, unknown> }> } {
  const patched: Array<{ id: string; data: Record<string, unknown> }> = [];
  const coll = {
    async patch(id: string, patch: Partial<Row>) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`no row ${id}`);
      Object.assign(row, patch);
      patched.push({ id, data: patch.data ?? {} });
      return row;
    },
    async find() {
      return rows;
    },
  } as unknown as DataCollection<Row>;
  return { coll, patched };
}

/**
 * The same, for a collection that HAS `bulkUpdate` — the path a real SQLite row
 * collection takes. Records the batches so a test can prove the run went
 * through one write per chunk rather than one per row.
 */
function fakeBulkRows(rows: Row[]): { coll: DataCollection<Row>; batches: Row[][]; patched: number } {
  const batches: Row[][] = [];
  const state = { patched: 0 };
  const coll = {
    async bulkUpdate(docs: Row[]) {
      batches.push(docs);
      for (const doc of docs) {
        const row = rows.find((r) => r.id === doc.id);
        if (row) Object.assign(row, doc);
      }
    },
    async patch() {
      state.patched++;
      throw new Error('bulkUpdate was available — patch must not be used');
    },
    async find() {
      return rows;
    },
  } as unknown as DataCollection<Row>;
  return {
    coll,
    batches,
    get patched() {
      return state.patched;
    },
  };
}

function row(id: string, data: Record<string, unknown>): Row {
  return { id, tableId: 't1', data, updatedAt: 0 };
}

const UPPER = `function render(row) { return String(row.name).toUpperCase(); }`;

const LOWER = `function render(row) { return String(row.name).toLowerCase(); }`;

describe('the rows a run hands back', () => {
  it('carries every target out, written or not, with this run applied', async () => {
    const rows = [row('a', { name: 'ada' }), row('b', { name: 'ADA' })];
    const { coll } = fakeBulkRows(rows);

    const result = await materializeColumnScript(coll, UPPER, 'shout', rows);

    expect(result.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.rows.map((r) => r.data['shout'])).toEqual(['ADA', 'ADA']);
  });

  it('lets a second column build on the first instead of undoing it', async () => {
    // A write replaces the whole row DOCUMENT. Running a second column from the
    // snapshot the first one started with therefore erased the first column —
    // `Run scripts` over two scripted columns left only the second written.
    const rows = [row('a', { name: 'Ada' })];
    const { coll } = fakeBulkRows(rows);

    const first = await materializeColumnScript(coll, UPPER, 'shout', rows);
    await materializeColumnScript(coll, LOWER, 'quiet', first.rows);

    expect(rows[0]!.data).toMatchObject({ name: 'Ada', shout: 'ADA', quiet: 'ada' });
  });
});

describe('materializeColumnScript', () => {
  it('writes what the script returns into the named field', async () => {
    const rows = [row('a', { name: 'ada' }), row('b', { name: 'bob' })];
    const { coll, patched } = fakeRows(rows);

    const result = await materializeColumnScript(coll, UPPER, 'shout', rows);

    expect(result.written).toBe(2);
    expect(result.failed).toBe(0);
    expect(patched.map((p) => p.data['shout'])).toEqual(['ADA', 'BOB']);
    // The other fields survive — a patch replaces the whole `data` object.
    expect(patched[0]?.data['name']).toBe('ada');
  });

  it('leaves a cell alone when the script returns what is already there', async () => {
    // Re-running a materialized column must be free, not a full rewrite that
    // moves every row's updatedAt and wakes up sync.
    const rows = [row('a', { name: 'ada', shout: 'ADA' }), row('b', { name: 'bob', shout: 'stale' })];
    const { coll, patched } = fakeRows(rows);

    const result = await materializeColumnScript(coll, UPPER, 'shout', rows);

    expect(result).toMatchObject({ written: 1, unchanged: 1, failed: 0 });
    expect(patched).toHaveLength(1);
    expect(patched[0]?.id).toBe('b');
  });

  it('treats a number and its string form as the same cell', async () => {
    // Typing 42 into a text column stores '42'; a script returning 42 has not
    // changed anything the user can see.
    const rows = [row('a', { n: 42, out: '42' })];
    const { coll } = fakeRows(rows);
    const result = await materializeColumnScript(coll, `function render(row) { return row.n; }`, 'out', rows);
    expect(result).toMatchObject({ written: 0, unchanged: 1 });
  });

  it('skips the rows the script throws on and reports the first message', async () => {
    // A one-off over real data usually has a few rows the script did not
    // anticipate. Stopping at the first would leave the column half written.
    const rows = [row('a', { name: 'ada' }), row('b', {}), row('c', { name: 'cy' })];
    const { coll, patched } = fakeRows(rows);
    const script = `function render(row) { if (!row.name) throw new Error('no name'); return row.name.toUpperCase(); }`;

    const result = await materializeColumnScript(coll, script, 'shout', rows);

    expect(result).toMatchObject({ written: 2, failed: 1, firstError: 'no name' });
    expect(patched.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('reports a compile error once per row rather than throwing', async () => {
    const rows = [row('a', { name: 'ada' })];
    const { coll, patched } = fakeRows(rows);
    const result = await materializeColumnScript(coll, 'function render(row) { return', 'shout', rows);
    expect(result.failed).toBe(1);
    expect(result.written).toBe(0);
    expect(patched).toHaveLength(0);
  });

  it('writes through bulkUpdate in batches when the collection offers it', async () => {
    // The reason this path exists: one round trip, one transaction and one
    // grid-waking broadcast per BATCH. A loop of patch() made 4 000 cells take
    // two minutes, so `patch` here throws rather than quietly being slow.
    const rows = Array.from({ length: 1100 }, (_, i) => row(`r${i}`, { name: `n${i}` }));
    const fake = fakeBulkRows(rows);

    const result = await materializeColumnScript(fake.coll, UPPER, 'shout', rows);

    expect(result).toMatchObject({ written: 1100, unchanged: 0, failed: 0 });
    expect(fake.patched).toBe(0);
    // 500 + 500 + the remaining 100 — three writes, not 1 100.
    expect(fake.batches.map((b) => b.length)).toEqual([500, 500, 100]);
    expect(rows[0]?.data['shout']).toBe('N0');
    expect(rows[1099]?.data['shout']).toBe('N1099');
  });

  it('stamps every written row with a new updatedAt', async () => {
    // Without this a materialized column looks untouched to replication, which
    // settles a row by comparing stamps — and would hand the old values back.
    const rows = [row('a', { name: 'ada' })];
    const fake = fakeBulkRows(rows);

    await materializeColumnScript(fake.coll, UPPER, 'shout', rows);

    expect(fake.batches[0]?.[0]?.updatedAt).toBeGreaterThan(0);
  });

  it('falls back to patch, stamp and all, when there is no bulkUpdate', async () => {
    const rows = [row('a', { name: 'ada' })];
    const { coll, patched } = fakeRows(rows);

    const result = await materializeColumnScript(coll, UPPER, 'shout', rows);

    expect(result.written).toBe(1);
    expect(patched).toHaveLength(1);
    expect(rows[0]?.updatedAt).toBeGreaterThan(0);
  });

  it('reports progress and ends on the total', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`r${i}`, { name: `n${i}` }));
    const { coll } = fakeRows(rows);
    const seen: Array<[number, number]> = [];
    await materializeColumnScript(coll, UPPER, 'shout', rows, (done, total) => seen.push([done, total]));
    expect(seen.at(-1)).toEqual([5, 5]);
  });
});

describe('materializeSummary', () => {
  it('names only what happened', () => {
    expect(materializeSummary({ written: 3, unchanged: 0, failed: 0, firstError: null }, 'shout')).toBe('3 cells written to “shout”.');
  });

  it('carries the failure reason', () => {
    const text = materializeSummary({ written: 1, unchanged: 2, failed: 1, firstError: 'no name' }, 'shout');
    expect(text).toContain('2 already correct');
    expect(text).toContain('no name');
  });
});
