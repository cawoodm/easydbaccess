// packages/renderer/src/db/truncation-note.ts
//
// One sentence for "you are not looking at all of it".
//
// A big table is read up to `ROW_FETCH_CAP` rows and no further (see
// `row-reader.ts`), which two callers have to own up to: the grid and a view
// window. They said it differently, or — the view — not at all, so the wording
// lives here and both use it.
//
// The SEARCH case is the one that misleads. A free-text query is mostly not
// pushable to the backend (the phrase→AND→OR fallback cannot be a WHERE clause),
// so it runs in memory over the rows that were fetched. An empty result then
// means "nothing in the first 20 000 rows", which reads exactly like "nothing".
// Filtering says something different — narrow it and the rest arrives — so it
// keeps its own sentence.

/** What the caller knows about the read it is showing. */
export interface TruncationFacts {
  /** Rows on screen (matches, when searching). */
  shown: number;
  /** What the read matched before the cap — a FLOOR when truncated. */
  total: number;
  /** Is a free-text search part of what produced this set? */
  searching: boolean;
  /** How many rows the read looked at before it stopped, when known. */
  searched?: number | undefined;
}

const n = (v: number): string => Math.max(0, Math.round(v)).toLocaleString();

/**
 * The warning for a truncated read, or `null` when there is nothing to warn
 * about. Callers render the string as-is.
 */
export function truncationNote(facts: TruncationFacts | null): string | null {
  if (!facts) return null;
  const { shown, total, searching, searched } = facts;
  if (searching) {
    // No "narrow the search" advice: narrowing a search does not fetch more
    // rows, it re-runs over the same ones. A column filter is what reaches the
    // rest, because that part IS pushed down to the store.
    const scope = searched && searched > 0 ? `the first ${n(searched)} rows` : 'the rows loaded so far';
    return shown === 0
      ? `Nothing found in ${scope} — this table is bigger, so there may be matches further in. Filter a column to search the rest.`
      : `Found ${n(shown)} in ${scope} — there may be more further in. Filter a column to search the rest.`;
  }
  return `Showing the first ${n(shown)} of ${n(total)}+ matching rows. Narrow the filter to see the rest.`;
}
