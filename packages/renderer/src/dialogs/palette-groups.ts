// The command palette's group ordering. Pure, kept out of
// command-palette-dialog.ts so it can be unit-tested without a DOM — the same
// split `palette-recent.ts` already makes for the Recent section.

import { RECENT_GROUP } from './palette-recent.js';

/** Group display order; a group not listed here sorts last, alphabetically. */
export const GROUP_RANK: Record<string, number> = {
  [RECENT_GROUP]: -1,
  Windows: 0,
  Actions: 1,
  App: 2,
  Tables: 3,
  Views: 4,
};

/**
 * Rank for a group nobody listed above — BEYOND every known rank, not one of
 * them.
 *
 * Unknown groups shared `Tables`'s 3 until v0.0.417, so the two interleaved by
 * insertion order. The palette draws a heading wherever the group changes from
 * one row to the next, so a group split into two runs got two headings:
 * `Workspace`, `Help`, `Data` and `Commands` all did it, and a test asking for
 * "the Workspace heading" found two of them.
 */
export const UNKNOWN_RANK = 100;

export function groupRank(group: string): number {
  return GROUP_RANK[group] ?? UNKNOWN_RANK;
}

/** Only the shape `orderByGroup` needs — the dialog's PaletteItem satisfies it. */
interface Grouped {
  group: string;
}

/**
 * Sort items by group rank, keeping each group in ONE run and preserving the
 * order items arrived in within a group.
 *
 * The name comparison only ever fires between two unknown groups, since the
 * known ranks are all distinct — which is what puts those in alphabetical
 * order, as `GROUP_RANK`'s comment promises.
 */
export function orderByGroup<T extends Grouped>(items: readonly T[]): T[] {
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const byRank = groupRank(a.it.group) - groupRank(b.it.group);
      if (byRank !== 0) return byRank;
      if (a.it.group !== b.it.group) return a.it.group.localeCompare(b.it.group);
      return a.i - b.i;
    })
    .map(({ it }) => it);
}
