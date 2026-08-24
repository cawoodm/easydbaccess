import { describe, expect, it } from 'vitest';
import { UNKNOWN_RANK, groupRank, orderByGroup } from '../../../packages/renderer/src/dialogs/palette-groups.js';

/**
 * The palette draws a heading wherever the group changes from one row to the
 * next, so every group has to come out as ONE contiguous run. It did not:
 * unknown groups shared `Tables`'s rank and interleaved with it, giving
 * `Workspace` two headings.
 */

const item = (group: string, id: string) => ({ group, id });

/** The group of each item, in order — what the headings are drawn from. */
const runs = (items: Array<{ group: string }>): string[] => items.map((i) => i.group).filter((g, i, all) => g !== all[i - 1]);

describe('orderByGroup', () => {
  it('puts the known groups in their listed order', () => {
    const out = orderByGroup([item('Views', 'a'), item('Actions', 'b'), item('Windows', 'c'), item('Recent', 'd')]);
    expect(runs(out)).toEqual(['Recent', 'Windows', 'Actions', 'Views']);
  });

  it('keeps an unknown group in one run, even interleaved with Tables', () => {
    // The exact shape of the bug: the palette registers Workspace commands and
    // table commands in an interleaved order.
    const out = orderByGroup([item('Workspace', 'w1'), item('Tables', 't1'), item('Workspace', 'w2'), item('Tables', 't2'), item('Workspace', 'w3')]);
    expect(runs(out)).toEqual(['Tables', 'Workspace']);
    expect(runs(out).filter((g) => g === 'Workspace')).toHaveLength(1);
  });

  it('sorts unknown groups after every known one, alphabetically', () => {
    const out = orderByGroup([item('Workspace', 'w'), item('Help', 'h'), item('Views', 'v'), item('Data', 'd'), item('Commands', 'c')]);
    expect(runs(out)).toEqual(['Views', 'Commands', 'Data', 'Help', 'Workspace']);
  });

  it('preserves the order items arrived in within a group', () => {
    const out = orderByGroup([item('App', '1'), item('Tables', 'x'), item('App', '2'), item('App', '3')]);
    expect(out.filter((i) => i.group === 'App').map((i) => i.id)).toEqual(['1', '2', '3']);
  });

  it('ranks a group nobody listed beyond every known one', () => {
    expect(groupRank('Workspace')).toBe(UNKNOWN_RANK);
    expect(groupRank('Views')).toBeLessThan(UNKNOWN_RANK);
    expect(groupRank('Recent')).toBeLessThan(groupRank('Windows'));
  });
});
