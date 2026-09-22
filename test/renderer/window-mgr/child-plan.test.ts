import { describe, expect, it } from 'vitest';
import { planChildren } from '../../../packages/renderer/src/window-mgr/child-plan.js';

/**
 * Turning one child list into another while moving as little as possible.
 *
 * The count of insertions is the thing under test, not a performance figure: an
 * insertion is a DOM MOVE, a move fires `disconnectedCallback` on everything in
 * the subtree, and a docked map or chart destroys its instance there. So "how
 * many nodes does this reflow disturb" is a correctness question, and every case
 * below that expects `insert` to be empty is a visualization that keeps working.
 */

/** Replay a plan against a list, so the result can be checked as well as the ops. */
function applied<T>(current: readonly T[], wanted: readonly T[]): T[] {
  const plan = planChildren(current, wanted);
  const list = current.filter((n) => !plan.drop.includes(n));
  for (const { node, before } of plan.insert) {
    const at = list.indexOf(node);
    if (at >= 0) list.splice(at, 1);
    const target = before === null ? list.length : list.indexOf(before);
    list.splice(target < 0 ? list.length : target, 0, node);
  }
  return list;
}

describe('planChildren', () => {
  it('does nothing when the list already matches', () => {
    expect(planChildren(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual({ drop: [], insert: [] });
  });

  it('appends without touching what is there — a pane docked onto a new row', () => {
    const plan = planChildren(['row0', 'split0'], ['row0', 'split0', 'row1', 'split1']);
    expect(plan.drop).toEqual([]);
    expect(plan.insert).toEqual([
      { node: 'row1', before: null },
      { node: 'split1', before: null },
    ]);
  });

  it('inserts mid-list without moving the neighbours — a pane joining a row', () => {
    // [paneA] becoming [paneA, splitter, paneB]: paneA must not be disturbed, or
    // the chart already in that row goes blank.
    const plan = planChildren(['paneA'], ['paneA', 'splitter', 'paneB']);
    expect(plan.insert.map((i) => i.node)).toEqual(['splitter', 'paneB']);
    expect(plan.insert.every((i) => i.node !== 'paneA')).toBe(true);
  });

  it('drops what is gone and then needs no insertion at all', () => {
    // Removing the FIRST row of two: the survivor is already at index 0 once the
    // first is dropped. This is why drops come before insertions.
    const plan = planChildren(['row0', 'split0', 'row1', 'split1'], ['row1', 'split1']);
    expect(plan.drop).toEqual(['row0', 'split0']);
    expect(plan.insert).toEqual([]);
  });

  it('drops a pane from the middle of a row and leaves the rest alone', () => {
    const plan = planChildren(['a', 's1', 'b', 's2', 'c'], ['a', 's1', 'c']);
    expect(plan.drop).toEqual(['b', 's2']);
    expect(plan.insert).toEqual([]);
  });

  it('moves only the node that actually changed places', () => {
    const plan = planChildren(['a', 'b', 'c'], ['b', 'a', 'c']);
    expect(plan.insert).toHaveLength(1);
    expect(applied(['a', 'b', 'c'], ['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
  });

  it('produces the wanted list for a full reversal', () => {
    expect(applied(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'])).toEqual(['d', 'c', 'b', 'a']);
  });

  it('produces the wanted list when everything changes at once', () => {
    expect(applied(['a', 'b', 'c'], ['x', 'c', 'y', 'a'])).toEqual(['x', 'c', 'y', 'a']);
  });

  it('empties a list', () => {
    expect(planChildren(['a', 'b'], [])).toEqual({ drop: ['a', 'b'], insert: [] });
  });

  it('fills an empty one', () => {
    expect(applied([], ['a', 'b'])).toEqual(['a', 'b']);
  });
});
