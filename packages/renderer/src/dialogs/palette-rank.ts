// The command palette's ordering WHILE SOMETHING IS TYPED. Pure, kept out of
// command-palette-dialog.ts so it can be unit-tested without a DOM — the same
// split `palette-groups.ts` and `palette-recent.ts` already make.
//
// An item matches on a haystack of title + group + keywords (and, for a button,
// its tooltip), which is deliberately generous: "space" should find "Switch
// workspace". What it must not do is decide the ORDER. Typing `workspace` put
// Export, Save, Settings and SQL console above Switch / New / Delete workspace,
// because those four are buttons in the `Actions` group (rank 1) that mention a
// workspace in their TOOLTIP, while the three commands that say it on their face
// are in `Workspace`, which nothing lists and which therefore ranks last. The
// user reads titles, so the best title match has to lead.
//
// Group order still decides everything when the box is EMPTY — see
// `palette-groups.ts`. This module only takes over once there is a query.

import { groupRank } from './palette-groups.js';

/** The query is the whole of the title. */
export const TITLE_EXACT = 0;
/** The title begins with it: `New workspace` for `new`. */
export const TITLE_START = 1;
/** It starts a word inside the title: `Switch workspace` for `workspace`. */
export const TITLE_WORD = 2;
/** It is in the title, mid-word: `Workspaces` for `spaces`. */
export const TITLE_ANYWHERE = 3;
/** Matched by something the user cannot see — a keyword, a tooltip, the group. */
export const ELSEWHERE = 4;

/**
 * A character that ends a word, for "starts a word inside the title".
 *
 * Anything that is not a letter or a digit, so `Go to: Sales` splits at the
 * colon and the space alike, and a hyphenated title breaks where it reads as
 * broken. Deliberately not `\b`, which would call the `s` in `Workspaces` a
 * word start for the query `spaces`.
 */
const WORD_BREAK = /[^\p{L}\p{N}]/u;

/**
 * How well an item's own title answers the query. **Lower is better.**
 *
 * `ELSEWHERE` for a title that does not contain the query at all — which is not
 * "no match", because the item is only being ranked at ALL if its haystack
 * matched. It means the reason it matched is not on screen.
 */
export function matchRank(title: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (q === '') return ELSEWHERE;
  const t = title.toLowerCase();
  if (t === q) return TITLE_EXACT;
  const at = t.indexOf(q);
  if (at < 0) return ELSEWHERE;
  if (at === 0) return TITLE_START;
  return WORD_BREAK.test(t[at - 1] ?? '') ? TITLE_WORD : TITLE_ANYWHERE;
}

/** Only the shape `orderByRelevance` needs — the dialog's PaletteItem satisfies it. */
interface Rankable {
  title: string;
  group: string;
}

/**
 * Order matched items by how well their titles answer `query`, keeping every
 * group in ONE contiguous run.
 *
 * Contiguity is not decoration: the palette draws a heading wherever the group
 * changes from one row to the next, so a group split into two runs gets two
 * headings — the bug `palette-groups.ts` exists to prevent, and one this must
 * not reintroduce. A GROUP therefore takes the rank of its best item and moves
 * as a whole; the items inside it are ordered by their own rank.
 *
 * Three tiebreaks, each doing one job:
 *
 *   * `groupRank` — two groups whose best match is equally good keep the order
 *     an empty palette would have given them, so nothing is reshuffled for no
 *     reason;
 *   * the group name — what `groupRank` itself falls back on for the groups it
 *     does not list;
 *   * the arrival index — Recent's newest-first order, and the alphabetical
 *     order of tables and views, both survive inside their group.
 */
export function orderByRelevance<T extends Rankable>(items: readonly T[], query: string): T[] {
  const ranked = items.map((it, i) => ({ it, i, rank: matchRank(it.title, query) }));

  const best = new Map<string, number>();
  for (const { it, rank } of ranked) best.set(it.group, Math.min(best.get(it.group) ?? ELSEWHERE, rank));

  return ranked
    .sort((a, b) => {
      const byGroupBest = (best.get(a.it.group) ?? ELSEWHERE) - (best.get(b.it.group) ?? ELSEWHERE);
      if (byGroupBest !== 0) return byGroupBest;
      if (a.it.group !== b.it.group) {
        const byGroup = groupRank(a.it.group) - groupRank(b.it.group);
        if (byGroup !== 0) return byGroup;
        return a.it.group.localeCompare(b.it.group);
      }
      return a.rank - b.rank || a.i - b.i;
    })
    .map(({ it }) => it);
}
