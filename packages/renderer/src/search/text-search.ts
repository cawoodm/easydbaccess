// packages/renderer/src/search/text-search.ts
//
// Free-text search with boolean operators and a smart fallback, shared by the
// table grid (per-table + global search) and the view window. Pure and
// DOM-free so it's unit-testable in isolation.
//
// Rules:
//   • Explicit operators — uppercase standalone `AND` / `OR` — build a boolean
//     query. `OR` has lower precedence than `AND`, so "a AND b OR c" means
//     "(a AND b) OR c". No parentheses. Lowercase "and"/"or" are ordinary
//     search words (so a query can still literally search for them).
//   • No operators, one word → plain substring match (unchanged behaviour).
//   • No operators, multiple words → try the whole phrase first; if that finds
//     nothing, fall back to AND (every word present), then to OR (any word).
//
// A term matches a row when `contains(row, term)` is true — the caller decides
// what "contains" means (here: any field value contains the term, so a phrase
// spanning two fields is NOT a phrase match, matching the old per-field logic).

/** Per-row predicate: does the row contain `needle` (already lower-cased)? */
export type ContainsFn<T> = (row: T, needle: string) => boolean;

type Parsed =
  | { kind: 'boolean'; groups: string[][] } // OR of AND-groups (terms lower-cased)
  | { kind: 'plain'; phrase: string; words: string[] }; // words lower-cased

/** Split a raw query into a boolean or plain shape (all terms lower-cased). */
export function parseSearchQuery(query: string): Parsed {
  const raw = query.trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const hasOp = tokens.some((t) => t === 'AND' || t === 'OR');
  if (!hasOp) {
    return { kind: 'plain', phrase: raw.toLowerCase(), words: tokens.map((t) => t.toLowerCase()) };
  }
  // Build OR-groups; `AND` is just a separator within a group.
  const groups: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (tok === 'OR') {
      groups.push(current);
      current = [];
    } else if (tok === 'AND') {
      /* within-group separator — no-op */
    } else {
      current.push(tok.toLowerCase());
    }
  }
  groups.push(current);
  const clean = groups.filter((g) => g.length > 0);
  // A query that was only operators (e.g. "AND") has no terms — treat as plain.
  if (clean.length === 0) return { kind: 'plain', phrase: raw.toLowerCase(), words: [] };
  return { kind: 'boolean', groups: clean };
}

/**
 * Return the subset of `rows` matching `query`, applying the rules above.
 * `contains(row, needle)` tests one lower-cased term against a row.
 */
export function searchRows<T>(rows: T[], query: string, contains: ContainsFn<T>): T[] {
  const parsed = parseSearchQuery(query);

  if (parsed.kind === 'boolean') {
    // Row matches if ANY OR-group has ALL its AND-terms present.
    return rows.filter((r) => parsed.groups.some((g) => g.every((term) => contains(r, term))));
  }

  const { phrase, words } = parsed;
  if (words.length <= 1) {
    // Empty query → everything; single word → plain substring.
    if (phrase === '') return rows;
    return rows.filter((r) => contains(r, phrase));
  }

  // Multiple plain words: phrase → AND → OR, stopping at the first non-empty set.
  const phraseHits = rows.filter((r) => contains(r, phrase));
  if (phraseHits.length > 0) return phraseHits;
  const andHits = rows.filter((r) => words.every((w) => contains(r, w)));
  if (andHits.length > 0) return andHits;
  return rows.filter((r) => words.some((w) => contains(r, w)));
}
