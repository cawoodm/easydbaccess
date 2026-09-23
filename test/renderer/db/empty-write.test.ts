import { describe, expect, it } from 'vitest';
import { describeHolding, firstWarning, holdingOf, holdsNothing, NOTHING, refusedNote, secondWarning, wouldWipe } from '../../../packages/renderer/src/db/edb/empty-write.js';

/**
 * The rule in front of every write to a user's file: an empty database must not
 * land on top of a full one without being confirmed twice.
 *
 * It reads neither the store nor a file stamp — only the two sets of BYTES,
 * measured the same way — so a bug in the bookkeeping the other guards read
 * cannot make this one agree with it.
 */

describe('holdingOf', () => {
  it('sums every workspace in the bytes', () => {
    expect(
      holdingOf([
        { tables: 3, views: 1 },
        { tables: 2, views: 0 },
      ]),
    ).toEqual({ workspaces: 2, tables: 5, views: 1 });
  });

  it('is nothing for a database with no workspaces at all', () => {
    expect(holdingOf([])).toEqual(NOTHING);
  });
});

describe('holdsNothing', () => {
  it('is true for no tables and no views', () => {
    expect(holdsNothing({ workspaces: 0, tables: 0, views: 0 })).toBe(true);
  });

  it('counts a view as work, not only a table', () => {
    expect(holdsNothing({ workspaces: 1, tables: 0, views: 1 })).toBe(false);
  });

  it('does NOT count the workspaces themselves', () => {
    // Three empty workspaces is the exact shape the reported data loss had: the
    // file looked populated by one measure and held nothing the user made.
    expect(holdsNothing({ workspaces: 3, tables: 0, views: 0 })).toBe(true);
  });
});

describe('wouldWipe', () => {
  const full = { workspaces: 1, tables: 4, views: 2 };
  const empty = { workspaces: 1, tables: 0, views: 0 };

  it('is true for an empty database landing on a full one', () => {
    expect(wouldWipe(full, empty)).toBe(true);
  });

  it('is false when the bytes hold work', () => {
    expect(wouldWipe(full, full)).toBe(false);
    expect(wouldWipe(full, { workspaces: 1, tables: 1, views: 0 })).toBe(false);
  });

  it('is false when the file holds nothing to lose', () => {
    // A first save is exactly this, and it must not be interrupted.
    expect(wouldWipe(NOTHING, empty)).toBe(false);
    expect(wouldWipe(empty, empty)).toBe(false);
  });

  it('does not fire on a SHRINK, only on a wipe', () => {
    // Deleting a table is ordinary work. A red two-step alarm on every such save
    // would be ignored within a day, which would cost more than it saves.
    expect(wouldWipe(full, { workspaces: 1, tables: 1, views: 0 })).toBe(false);
  });
});

describe('describeHolding', () => {
  it('names tables, and views only when there are some', () => {
    expect(describeHolding({ workspaces: 1, tables: 4, views: 2 })).toBe('4 tables and 2 views');
    expect(describeHolding({ workspaces: 1, tables: 4, views: 0 })).toBe('4 tables');
  });

  it('is singular for one', () => {
    expect(describeHolding({ workspaces: 1, tables: 1, views: 1 })).toBe('1 table and 1 view');
  });
});

describe('the two warnings', () => {
  const full = { workspaces: 1, tables: 4, views: 0 };
  const empty = { workspaces: 1, tables: 0, views: 0 };

  it('the first names the file, both sides, and says there is no undo', () => {
    const text = firstWarning('sales.edb', full, empty);
    expect(text).toContain('sales.edb');
    expect(text).toContain('4 tables');
    expect(text).toContain('no undo');
    // And it points at the way out, because the file is usually the good copy.
    expect(text).toMatch(/open it instead/);
  });

  it('the second is worded as the loss, not as the action', () => {
    const text = secondWarning('sales.edb', full);
    expect(text).toContain('deletes 4 tables');
    expect(text).toContain('sales.edb');
    expect(text).toContain('Nothing else will ask');
  });

  it('a refusal says plainly that the file is untouched', () => {
    expect(refusedNote('sales.edb')).toBe('Nothing was written. “sales.edb” is untouched.');
  });
});
