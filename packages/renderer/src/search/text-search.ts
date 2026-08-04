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

import { matchesColumnFilter } from '@easydb/shared';

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

/**
 * A searchable column: the data key plus an optional human label to also match
 * on, and its type — `array` makes a `field:value` term match one MEMBER of the
 * cell rather than the whole list (see `column-filter.ts`).
 */
export interface SearchField {
  field: string;
  label?: string | undefined;
  type?: string | undefined;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Field-aware free-text search over `{ data }` rows, sharing the boolean /
 * phrase engine of {@link searchRows}.
 *
 * A term written `field:query` (field name OR label, case-insensitive) tests
 * ONLY that column through the column-filter mini-language — so `!` (negate),
 * `^` (starts-with), comma-OR and `NULL` all work inside it (e.g.
 * `read:!true`, `status:^A`, `city:Paris,Zurich`). A space right after a known
 * field's colon is tolerated (`read: !true`). Any other term is a plain
 * substring across all field values, exactly as before. Top-level `AND` / `OR`
 * and the plain phrase→AND→OR fallback are unchanged.
 */
export function searchRowsByField<T extends { data: Record<string, unknown> }>(
  rows: T[],
  query: string,
  fields: SearchField[],
): T[] {
  // Lower-cased field name / label → the real data key.
  const byName = new Map<string, string>();
  const typeOf = new Map<string, string | undefined>();
  for (const f of fields) {
    byName.set(f.field.toLowerCase(), f.field);
    if (f.label) byName.set(f.label.toLowerCase(), f.field);
    typeOf.set(f.field, f.type);
  }
  // Collapse `field: value` → `field:value` for KNOWN fields only, so a value
  // typed after a space survives whitespace tokenisation. Longest names first
  // so `created_at:` isn't shadowed by a shorter `created:`.
  const names = [...byName.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  let q = query;
  if (names.length > 0) {
    q = q.replace(new RegExp(`(^|\\s)(${names.map(escapeRe).join('|')}):\\s+`, 'gi'), '$1$2:');
  }
  const contains: ContainsFn<T> = (row, needle) => {
    const colon = needle.indexOf(':');
    if (colon > 0) {
      const real = byName.get(needle.slice(0, colon));
      if (real) {
        return matchesColumnFilter(row.data[real], needle.slice(colon + 1), {
          type: typeOf.get(real),
        });
      }
    }
    return Object.values(row.data).some(
      (v) => v != null && String(v).toLowerCase().includes(needle),
    );
  };
  return searchRows(rows, q, contains);
}
