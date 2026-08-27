import { describe, expect, it } from 'vitest';
import {
  countDiffs,
  defaultChoice,
  describeDiffs,
  diffRows,
  diffTables,
  inStep,
  planRows,
  tableTouchedAt,
  winnerOf,
  type RowDiff,
  type RowStamp,
  type TableStamp,
} from '../../../packages/shared/src/replicate.js';

/**
 * The rules for settling two copies of one workspace.
 *
 * The whole feature turns on two of these and neither is obvious:
 *
 *  - `newest` NEVER deletes. A row one side has and the other does not is not a
 *    row that lost — a missing row and a deleted row are indistinguishable here —
 *    so the side that has it wins and it is carried across.
 *  - A table's stamp includes its ROWS. Editing a cell does not write the table
 *    document, so a table with an hour of edits in it has an untouched doc.
 */

const table = (over: Partial<TableStamp> = {}): TableStamp => ({ id: 'a', name: 'Notes', updatedAt: 100, rows: 3, lastRowAt: 100, ...over });

describe('tableTouchedAt', () => {
  it('takes the newer of the document and its rows', () => {
    expect(tableTouchedAt(table({ updatedAt: 100, lastRowAt: 500 }))).toBe(500);
    expect(tableTouchedAt(table({ updatedAt: 900, lastRowAt: 500 }))).toBe(900);
  });

  it('is the document alone for an empty table', () => {
    expect(tableTouchedAt(table({ updatedAt: 700, rows: 0, lastRowAt: 0 }))).toBe(700);
  });
});

describe('diffTables', () => {
  it('calls a pair with matching stamps and counts the same', () => {
    const [d] = diffTables([table()], [table()]);
    expect(d?.state).toBe('same');
    expect(d?.newer).toBe('same');
  });

  it('sees an edited row even though the document did not move', () => {
    const [d] = diffTables([table({ lastRowAt: 100 })], [table({ lastRowAt: 400 })]);
    expect(d?.state).toBe('differs');
    expect(d?.newer).toBe('disk');
  });

  it('sees a row count that moved, even at the same instant', () => {
    const [d] = diffTables([table({ rows: 3 })], [table({ rows: 4 })]);
    expect(d?.state).toBe('differs');
    // Nothing can be concluded about which is newer, so nothing is claimed.
    expect(d?.newer).toBe('same');
  });

  it('pairs a re-imported table by NAME when its id changed', () => {
    // The ordinary refresh loop for anything backed by a URL: delete, re-import,
    // new id, same name. Matching on the id alone would offer to keep both.
    const [d] = diffTables([table({ id: 'old' })], [table({ id: 'new', lastRowAt: 800 })]);
    expect(d?.state).toBe('differs');
    expect(d?.here?.id).toBe('old');
    expect(d?.disk?.id).toBe('new');
  });

  it('reports what only one side has', () => {
    const diffs = diffTables([table({ id: 'a', name: 'Here' })], [table({ id: 'b', name: 'There' })]);
    expect(diffs.map((d) => [d.name, d.state])).toEqual([
      ['Here', 'here-only'],
      ['There', 'disk-only'],
    ]);
  });

  it('sorts by name, because a person reads it', () => {
    const diffs = diffTables([table({ id: '1', name: 'Zebra' }), table({ id: '2', name: 'Apple' })], []);
    expect(diffs.map((d) => d.name)).toEqual(['Apple', 'Zebra']);
  });

  it('does not claim a newer side where one copy is missing', () => {
    // The trap this guards: "the side that exists is newer" invites a caller to
    // delete the one that does not.
    const [d] = diffTables([table()], []);
    expect(d?.newer).toBe('same');
  });
});

describe('diffRows', () => {
  const rows = (...s: Array<[string, number]>): RowStamp[] => s.map(([id, updatedAt]) => ({ id, updatedAt }));

  it('pairs by id and settles by timestamp', () => {
    const out = diffRows(rows(['r1', 100], ['r2', 200]), rows(['r1', 100], ['r2', 900]));
    expect(out.find((d) => d.id === 'r1')?.state).toBe('same');
    const r2 = out.find((d) => d.id === 'r2');
    expect(r2?.state).toBe('differs');
    expect(r2?.newer).toBe('disk');
  });

  it('reports a row only one side has', () => {
    const out = diffRows(rows(['mine', 1]), rows(['theirs', 1]));
    expect(out.map((d) => [d.id, d.state])).toEqual([
      ['mine', 'here-only'],
      ['theirs', 'disk-only'],
    ]);
  });
});

describe('winnerOf', () => {
  it('takes an explicit answer at its word, one-sided or not', () => {
    // "Make this side match the other" is a request to delete, and it is the only
    // way to ask for one.
    expect(winnerOf({ state: 'here-only', newer: 'same' }, 'disk')).toBe('disk');
    expect(winnerOf({ state: 'disk-only', newer: 'same' }, 'here')).toBe('here');
  });

  it('never deletes on `newest` — the side that HAS it wins', () => {
    expect(winnerOf({ state: 'here-only', newer: 'same' }, 'newest')).toBe('here');
    expect(winnerOf({ state: 'disk-only', newer: 'same' }, 'newest')).toBe('disk');
  });

  it('picks the newer side of a real disagreement', () => {
    expect(winnerOf({ state: 'differs', newer: 'disk' }, 'newest')).toBe('disk');
  });

  it('refuses a disagreement with no newer side rather than guessing', () => {
    expect(winnerOf({ state: 'differs', newer: 'same' }, 'newest')).toBeNull();
  });

  it('touches nothing on skip', () => {
    expect(winnerOf({ state: 'differs', newer: 'disk' }, 'skip')).toBeNull();
  });
});

describe('defaultChoice', () => {
  it('leaves matching things alone and settles the rest by the clock', () => {
    expect(defaultChoice('same')).toBe('skip');
    expect(defaultChoice('differs')).toBe('newest');
    expect(defaultChoice('here-only')).toBe('newest');
    expect(defaultChoice('disk-only')).toBe('newest');
  });
});

describe('planRows', () => {
  const diff = (over: Partial<RowDiff>): RowDiff => ({ id: 'r', state: 'differs', newer: 'same', ...over });

  it('moves a differing row towards the loser', () => {
    const plan = planRows([diff({ id: 'r1', state: 'differs', newer: 'disk' })], () => 'newest');
    expect(plan.pull).toEqual(['r1']);
    expect(plan.push).toEqual([]);
  });

  it('carries a one-sided row across instead of dropping it', () => {
    const plan = planRows([diff({ id: 'mine', state: 'here-only' }), diff({ id: 'theirs', state: 'disk-only' })], () => 'newest');
    expect(plan.push).toEqual(['mine']);
    expect(plan.pull).toEqual(['theirs']);
    expect(plan.dropHere).toEqual([]);
    expect(plan.dropDisk).toEqual([]);
  });

  it('deletes only when the user asked one side to match the other', () => {
    const plan = planRows([diff({ id: 'mine', state: 'here-only' })], () => 'disk');
    expect(plan.dropHere).toEqual(['mine']);
    expect(plan.pull).toEqual([]);
  });

  it('ignores rows that match', () => {
    const plan = planRows([diff({ id: 'r1', state: 'same' })], () => 'disk');
    expect(plan).toEqual({ pull: [], push: [], dropHere: [], dropDisk: [] });
  });

  it('answers each row on its own', () => {
    const answers = new Map([
      ['r1', 'here' as const],
      ['r2', 'disk' as const],
    ]);
    const plan = planRows([diff({ id: 'r1' }), diff({ id: 'r2' })], (d) => answers.get(d.id) ?? 'skip');
    expect(plan.push).toEqual(['r1']);
    expect(plan.pull).toEqual(['r2']);
  });
});

describe('countDiffs / describeDiffs', () => {
  it('counts each kind', () => {
    const counts = countDiffs([{ state: 'same' }, { state: 'differs' }, { state: 'here-only' }, { state: 'disk-only' }, { state: 'differs' }]);
    expect(counts).toEqual({ same: 1, differs: 2, hereOnly: 1, diskOnly: 1 });
  });

  it('is in step only when nothing differs at all', () => {
    expect(inStep(countDiffs([{ state: 'same' }, { state: 'same' }]))).toBe(true);
    expect(inStep(countDiffs([{ state: 'same' }, { state: 'disk-only' }]))).toBe(false);
  });

  it('says nothing about the tables that match', () => {
    expect(describeDiffs(countDiffs([{ state: 'same' }, { state: 'same' }]))).toBe('');
  });

  it('reads as a sentence', () => {
    const counts = countDiffs([{ state: 'differs' }, { state: 'here-only' }, { state: 'disk-only' }, { state: 'disk-only' }]);
    expect(describeDiffs(counts)).toBe('1 table differs, 1 table only here, 2 tables only in the file');
  });
});
