// packages/renderer/src/search/column-filter.ts
//
// Per-column filter matching, shared by the table grid (live + faceted) and
// the read-only view windows. Pure and DOM-free so it's unit-testable.
//
// A filter is a COMMA-SEPARATED list of tokens. Each token may be negated with
// a leading `!` and/or anchored to the start of the cell with a leading `^`. A
// row passes when it matches at least one positive token (or there are none)
// and matches no negative token:
//
//   `Sweden,Norway`      → Sweden OR Norway
//   `!Closed,!Cancelled` → everything except those two
//   `Open,!urgent`       → Open, but not the urgent ones
//   `^S`                 → cells that START WITH "S"
//   `!^S`                → cells that do NOT start with "S"
//   `"Berlin, DE",Zurich` → a value containing a comma must be quoted
//
// Per-token semantics (case-insensitive):
//   • plain text        → substring match.
//   • `^text`           → starts-with match, anchored at the first character.
//   • `!text`           → NOT substring. Because a null or empty cell never
//     contains a non-empty term, `!true` on a boolean column also surfaces the
//     empty/null rows.
//   • `NULL`            → cell is null/undefined or (after trim) empty.
//   • `!NULL`           → cell has any non-empty value.
//   • `!` alone         → same as `!NULL` (cell has a value).
//   • empty query       → matches everything (no filter).
//
// `NULL` is matched as a whole token (case-insensitive), so a plain search for
// the literal text "null" inside a cell is intentionally not reachable — the
// null test wins. `^` beats it: `^NULL` looks for cells starting with the TEXT
// "null". Quote a token to search for a literal leading `!` or `^` (`"^caret"`).

/**
 * One term of a column filter. `negate` excludes instead of includes; `prefix`
 * anchors the match to the start of the cell instead of matching anywhere.
 */
export interface FilterToken {
  term: string;
  negate: boolean;
  prefix?: boolean;
}

/** Is a cell value considered empty/null for filtering purposes? */
function isNullish(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

/**
 * Split a raw filter string into its tokens. Commas separate; double quotes
 * protect a comma inside a value (`""` inside a quoted run is a literal quote).
 * A leading `!` (negate) and `^` (starts-with) are consumed in that order,
 * outside quotes only. A token whose text is empty is dropped, so `a,,b` is
 * just `a` OR `b` — but a lone `!` survives, since it means "has a value".
 */
export function parseColumnFilter(raw: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let buf = '';
  let sawText = false; // did this token contain any character at all?
  let quoted = false; // currently inside a quoted run
  let hadQuote = false; // this token was quoted, so keep its whitespace verbatim
  let negate = false;
  let prefix = false;
  let atStart = true; // still eligible to consume a leading `!` / `^`

  const flush = () => {
    const term = hadQuote ? buf : buf.trim();
    if (sawText || negate) tokens.push(prefix ? { term, negate, prefix } : { term, negate });
    buf = '';
    sawText = false;
    quoted = false;
    hadQuote = false;
    negate = false;
    prefix = false;
    atStart = true;
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"') {
      // A quote anywhere in the token opens/closes a quoted run; a doubled
      // quote inside one is an escaped literal.
      if (quoted && raw[i + 1] === '"') {
        buf += '"';
        sawText = true;
        i++;
        continue;
      }
      quoted = !quoted;
      hadQuote = true;
      sawText = true;
      atStart = false;
      continue;
    }
    if (ch === ',' && !quoted) {
      flush();
      continue;
    }
    // `!` and `^` are modifiers, not text — each may appear once, before the
    // term. `!^S` and `^S` both work; a second one is treated as literal text.
    if (ch === '!' && !quoted && atStart && !negate && !prefix) {
      negate = true;
      continue;
    }
    if (ch === '^' && !quoted && atStart && !prefix) {
      prefix = true;
      continue;
    }
    if (!(atStart && !quoted && /\s/.test(ch))) atStart = false;
    buf += ch;
    if (!/\s/.test(ch)) sawText = true;
  }
  flush();
  return tokens;
}

/**
 * Does a term need quoting to survive a `parseColumnFilter` round-trip? A
 * leading `!` or `^` must be quoted or it would come back as a modifier.
 */
function needsQuoting(term: string): boolean {
  return (
    term.includes(',') ||
    term.includes('"') ||
    term !== term.trim() ||
    term === '' ||
    term.startsWith('!') ||
    term.startsWith('^')
  );
}

/** Render tokens back into a filter string, quoting terms that need it. */
export function composeColumnFilter(tokens: FilterToken[]): string {
  return tokens
    .map((t) => {
      const body =
        t.term === '' && t.negate
          ? '' // a bare `!` — "has a value"
          : needsQuoting(t.term)
            ? `"${t.term.replace(/"/g, '""')}"`
            : t.term;
      return (t.negate ? '!' : '') + (t.prefix ? '^' : '') + body;
    })
    .join(',');
}

/** Does `value` satisfy a single filter token? */
function matchesTerm(value: unknown, token: FilterToken): boolean {
  const term = token.term;
  // An empty term (a lone `!`) always tests emptiness — `^` cannot anchor
  // nothing. `NULL` tests emptiness too, unless `^` asked for the literal text.
  if (term.trim() === '') return isNullish(value);
  if (!token.prefix && term.toUpperCase() === 'NULL') return isNullish(value);
  const haystack = String(value ?? '').toLowerCase();
  const needle = term.toLowerCase();
  return token.prefix ? haystack.startsWith(needle) : haystack.includes(needle);
}

/** Does `value` satisfy the per-column filter `rawQuery`? */
export function matchesColumnFilter(value: unknown, rawQuery: string): boolean {
  const tokens = parseColumnFilter(rawQuery);
  if (tokens.length === 0) return true;

  // Any excluded term wins outright.
  for (const t of tokens) {
    if (t.negate && matchesTerm(value, t)) return false;
  }
  const positives = tokens.filter((t) => !t.negate);
  if (positives.length === 0) return true;
  return positives.some((t) => matchesTerm(value, t));
}
