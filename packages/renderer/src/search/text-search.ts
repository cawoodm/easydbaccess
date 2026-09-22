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

import { composeColumnFilter, groupColumnFilter, isListExpression, matchesColumnFilter, parseColumnFilter, plainTextOf } from '@easydb/shared';

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
 * One filter expression against a WHOLE row — the search box's terms are not
 * tied to a column, so each token has to be read across all of them.
 *
 * The two halves of the filter language mean different things once there is more
 * than one field to look in, and getting that backwards is what made a plain
 * `values.some(matchesColumnFilter)` unusable here:
 *
 *   • a POSITIVE token is satisfied by ANY one field — that is what a search box
 *     has always done;
 *   • an EXCLUSION has to hold of EVERY field. `!CC` means "this row has no CC
 *     in it", not "some column of it isn't CC" — which is true of nearly every
 *     row and would exclude nothing at all.
 *
 * Each token is handed back to `matchesColumnFilter` rather than re-implemented,
 * so the reading of `^`, `=`, `NULL` and quoting stays in one place. An
 * exclusion is tested through its own POSITIVE form and the answer inverted,
 * which is what puts the "every field" quantifier on the outside.
 */
export function rowMatchesFilterExpr(values: readonly unknown[], raw: string): boolean {
  const groups = groupColumnFilter(parseColumnFilter(raw));
  if (groups.length === 0) return true;
  const anyField = (expr: string): boolean => (expr === '' ? false : values.some((v) => matchesColumnFilter(v, expr)));
  const isVeto = (g: (typeof groups)[number]): boolean => g.length === 1 && g[0]!.negate;

  // Same shape as `matchesColumnFilter`: a lone negative token vetoes outright,
  // so `Open,!urgent` still reads as "Open but not urgent".
  for (const g of groups.filter(isVeto)) {
    if (anyField(composeColumnFilter([{ ...g[0]!, negate: false }]))) return false;
  }
  const required = groups.filter((g) => !isVeto(g));
  if (required.length === 0) return true;
  return required.some((g) => anyField(composeColumnFilter(g)));
}

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
export function searchRowsByField<T extends { data: Record<string, unknown> }>(rows: T[], query: string, fields: SearchField[]): T[] {
  // The whole query in quotes is the escape hatch, and it has to be honoured
  // BEFORE `searchRows` splits on whitespace: `"Berlin, DE"` would otherwise
  // become the two words `"Berlin,` and `DE"` and go down the AND/OR fallback,
  // which is exactly the literal reading the quotes were asking to avoid.
  const whole = query.trim();
  if (whole !== '' && !isListExpression(whole) && plainTextOf(whole) !== whole) {
    const literal = plainTextOf(whole).toLowerCase();
    if (literal === '') return rows;
    return rows.filter((r) => Object.values(r.data).some((v) => v != null && String(v).toLowerCase().includes(literal)));
  }
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
    // A term with no `field:` prefix reads the SAME language, across every
    // column — but only when it LOOKS like a list. `!CC,Holiday` used to search
    // for the literal text "!cc,holiday" and find nothing; reading every term as
    // the language instead cost us the ability to search for `Berlin, DE`.
    // `isListExpression` is the one rule that decides, and quoting the whole
    // term is how a user overrides it.
    if (!isListExpression(needle)) {
      const literal = plainTextOf(needle);
      return Object.values(row.data).some((v) => v != null && String(v).toLowerCase().includes(literal));
    }
    return rowMatchesFilterExpr(Object.values(row.data), needle);
  };
  return searchRows(rows, q, contains);
}
