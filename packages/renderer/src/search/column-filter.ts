// packages/renderer/src/search/column-filter.ts
//
// Per-column filter matching, shared by the table grid (live + faceted) and
// the read-only view windows. Pure and DOM-free so it's unit-testable.
//
// A filter is a COMMA-SEPARATED list of tokens. Each token may be negated with
// a leading `!` and/or anchored with a leading `^` (starts-with) or `=` (exact
// match) — `^` and `=` are mutually exclusive, both being anchors. A row
// passes when it matches at least one positive token (or there are none) and
// matches no negative token:
//
//   `Sweden,Norway`      → Sweden OR Norway
//   `!Closed,!Cancelled` → everything except those two
//   `Open,!urgent`       → Open, but not the urgent ones
//   `^S`                 → cells that START WITH "S"
//   `!^S`                → cells that do NOT start with "S"
//   `=foo`               → cells that are EXACTLY "foo"
//   `!=foo`              → cells that are NOT exactly "foo"
//   `"Berlin, DE",Zurich` → a value containing a comma must be quoted
//
// Two tokens can also be joined with a standalone uppercase `AND`, which is the
// one thing a comma cannot say — a comma ORs. `OR` is accepted as a spelled-out
// comma, and `AND` binds tighter, so the shape matches the search box
// (`text-search.ts`) that users meet first:
//
//   `!NULL AND Biden`    → has a value AND contains "Biden"
//   `^B AND !Bush`       → starts with "B" but is not a Bush
//   `a AND b,c`          → (a AND b) OR c
//   `a OR b`             → same as `a,b`
//
// Only UPPERCASE `AND`/`OR` standing alone between spaces are operators, so
// "brand" and "Andrew" are ordinary text, and a term that really contains the
// word is quoted: `"Salt AND Pepper"`. A comma-separated NEGATIVE token keeps
// excluding on its own (`Open,!urgent` is "Open but not urgent") — only an
// explicit `AND` builds a group that must match as a whole.
//
// Per-token semantics (case-insensitive):
//   • plain text        → substring match.
//   • `^text`           → starts-with match, anchored at the first character.
//   • `=text`           → exact match against the WHOLE cell (not trimmed).
//   • `!text`           → NOT substring. Because a null or empty cell never
//     contains a non-empty term, `!true` on a boolean column also surfaces the
//     empty/null rows.
//   • `!=text`          → NOT an exact match.
//   • `NULL`            → cell is null/undefined or (after trim) empty.
//   • `!NULL`           → cell has any non-empty value.
//   • `!` alone         → same as `!NULL` (cell has a value).
//   • empty query       → matches everything (no filter).
//
// `NULL` is matched as a whole token (case-insensitive), so a plain search for
// the literal text "null" inside a cell is intentionally not reachable — the
// null test wins. `^` and `=` both beat it: `^NULL` looks for cells starting
// with the TEXT "null", `=NULL` looks for cells that ARE exactly "null". Quote
// a token to search for a literal leading `!`, `^` or `=` (`"^caret"`).
//
// An `array` column (pass `{ type: 'array' }`) matches PER MEMBER: the cell is
// taken apart by `util/array-cell.ts` and a token that hits any one member hits
// the cell. `=Foo` therefore selects the rows whose list CONTAINS exactly `Foo`,
// which is what the funnel dropdown needs — its tokens are exact, and the whole
// cell (`Foo,Bar`) is never exactly one value. Negation still reads as "no
// member matches", and `NULL` as "no members at all".

import { arrayMembers } from '../util/array-cell.js';

/**
 * One term of a column filter. `negate` excludes instead of includes; `prefix`
 * anchors the match to the start of the cell instead of matching anywhere;
 * `exact` requires the WHOLE cell to equal the term. `prefix` and `exact` are
 * mutually exclusive (both are anchors).
 */
export interface FilterToken {
  term: string;
  negate: boolean;
  prefix?: boolean;
  exact?: boolean;
  /**
   * This token is joined to the one BEFORE it with `AND`, so the two must match
   * the same cell together. It describes the separator, not the term, which is
   * why the flat token list stays the public shape: every existing consumer
   * (filter popover, view pills, the Datasette query translator) keeps reading
   * the list it already read, and only the matcher groups it.
   */
  and?: boolean;
}

/** Is a cell value considered empty/null for filtering purposes? */
function isNullish(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

/**
 * Split a raw filter string into its tokens. Commas separate; double quotes
 * protect a comma inside a value (`""` inside a quoted run is a literal quote).
 * A leading `!` (negate) and `^` (starts-with) OR `=` (exact) are consumed in
 * that order, outside quotes only — `^` and `=` are mutually exclusive anchors,
 * so once one is consumed the other is treated as literal text. A token whose
 * text is empty is dropped, so `a,,b` is just `a` OR `b` — but a lone `!`
 * survives, since it means "has a value".
 *
 * A standalone uppercase `AND` / `OR` between tokens is an operator: `OR` reads
 * as a comma, and `AND` sets `and` on the token that follows it.
 */
export function parseColumnFilter(raw: string): FilterToken[] {
  const tokens: FilterToken[] = [];
  let buf = '';
  let sawText = false; // did this token contain any character at all?
  let quoted = false; // currently inside a quoted run
  let hadQuote = false; // this token was quoted, so keep its whitespace verbatim
  let negate = false;
  let prefix = false;
  let exact = false;
  let atStart = true; // still eligible to consume a leading `!` / `^` / `=`
  let pendingAnd = false; // an `AND` was read; it belongs to the NEXT token

  const flush = () => {
    const term = hadQuote ? buf : buf.trim();
    if (sawText || negate) {
      const token: FilterToken = { term, negate };
      if (prefix) token.prefix = true;
      if (exact) token.exact = true;
      // Nothing to join to when this is the first token — a leading `AND` is
      // dropped rather than left dangling for `composeColumnFilter` to emit.
      if (pendingAnd && tokens.length > 0) token.and = true;
      tokens.push(token);
    }
    pendingAnd = false;
    buf = '';
    sawText = false;
    quoted = false;
    hadQuote = false;
    negate = false;
    prefix = false;
    exact = false;
    atStart = true;
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    // An operator needs whitespace in front of it and a token boundary behind,
    // so `brand` and `Andrew` stay text and only ` AND ` / ` OR ` separate. The
    // test is case-SENSITIVE, matching the search box: lowercase "and" is a word.
    if (!quoted && /\s/.test(ch)) {
      const op = /^\s+(AND|OR)(?=[\s,]|$)/.exec(raw.slice(i));
      if (op && (sawText || negate)) {
        flush();
        pendingAnd = op[1] === 'AND';
        i += op[0].length - 1;
        continue;
      }
    }
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
    // `!`, `^` and `=` are modifiers, not text — each may appear once, before
    // the term, in the order `!` then `^`/`=`. `^` and `=` are mutually
    // exclusive anchors: whichever is seen first wins, and a second one (or
    // one after the other anchor) is treated as literal text.
    if (ch === '!' && !quoted && atStart && !negate && !prefix && !exact) {
      negate = true;
      continue;
    }
    if (ch === '=' && !quoted && atStart && !prefix && !exact) {
      exact = true;
      continue;
    }
    if (ch === '^' && !quoted && atStart && !prefix && !exact) {
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
 * leading `!`, `^` or `=` must be quoted or it would come back as a modifier,
 * and a term carrying a standalone `AND` / `OR` would come back split in two.
 */
function needsQuoting(term: string): boolean {
  return (
    term.includes(',') ||
    term.includes('"') ||
    term !== term.trim() ||
    term === '' ||
    term.startsWith('!') ||
    term.startsWith('^') ||
    term.startsWith('=') ||
    /\s(AND|OR)(?=[\s,]|$)/.test(term)
  );
}

/** Render tokens back into a filter string, quoting terms that need it. */
export function composeColumnFilter(tokens: FilterToken[]): string {
  let out = '';
  tokens.forEach((t, i) => {
    const body =
      t.term === '' && t.negate
        ? '' // a bare `!` — "has a value"
        : needsQuoting(t.term)
          ? `"${t.term.replace(/"/g, '""')}"`
          : t.term;
    const anchor = t.exact ? '=' : t.prefix ? '^' : '';
    const text = (t.negate ? '!' : '') + anchor + body;
    // `and` joins to the token before it, so it cannot open the expression: a
    // caller that dropped the first token (the view pills do) must not get a
    // string that starts with " AND ".
    if (i === 0) out = text;
    else out += t.and ? ` AND ${text}` : `,${text}`;
  });
  return out;
}

/**
 * Split the flat token list into AND-groups: a token flagged `and` continues the
 * group before it, anything else opens a new one.
 */
export function groupColumnFilter(tokens: FilterToken[]): FilterToken[][] {
  const groups: FilterToken[][] = [];
  for (const t of tokens) {
    const last = groups[groups.length - 1];
    if (t.and && last) last.push(t);
    else groups.push([t]);
  }
  return groups;
}

/**
 * Does one piece of text satisfy a token's anchoring? Not trimmed — `=` is an
 * exact match against the whole thing, so " foo " is not `=foo`.
 */
function matchesText(value: unknown, token: FilterToken): boolean {
  const haystack = String(value ?? '').toLowerCase();
  const needle = token.term.toLowerCase();
  if (token.exact) return haystack === needle;
  return token.prefix ? haystack.startsWith(needle) : haystack.includes(needle);
}

/** An array cell is empty when it has no members, whatever its spelling. */
function isEmptyCell(value: unknown, members: string[] | null): boolean {
  return members ? members.length === 0 : isNullish(value);
}

/**
 * Does `value` satisfy a single filter token? `members` is non-null for an
 * `array` column, in which case the token tests each member and one hit is
 * enough.
 */
function matchesTerm(value: unknown, token: FilterToken, members: string[] | null): boolean {
  const term = token.term;
  // An empty term (a lone `!`) always tests emptiness — `^`/`=` cannot anchor
  // nothing. `NULL` tests emptiness too, unless `^` or `=` asked for the
  // literal text.
  if (term.trim() === '') return isEmptyCell(value, members);
  if (!token.prefix && !token.exact && term.toUpperCase() === 'NULL') {
    return isEmptyCell(value, members);
  }
  if (members) return members.some((m) => matchesText(m, token));
  return matchesText(value, token);
}

/** Does the cell satisfy every token of one AND-group? */
function matchesGroup(value: unknown, group: FilterToken[], members: string[] | null): boolean {
  return group.every((t) =>
    t.negate ? !matchesTerm(value, t, members) : matchesTerm(value, t, members),
  );
}

/**
 * Does `value` satisfy the per-column filter `rawQuery`?
 *
 * `opts.type` is the column's type. Only `array` changes anything — it switches
 * matching to per-member (see the header). Every other type reads the cell as
 * one value, so a caller that knows no type can leave it out.
 */
export function matchesColumnFilter(
  value: unknown,
  rawQuery: string,
  opts?: { type?: string | undefined },
): boolean {
  const groups = groupColumnFilter(parseColumnFilter(rawQuery));
  if (groups.length === 0) return true;
  const members = opts?.type === 'array' ? arrayMembers(value) : null;

  // A comma-separated NEGATIVE token on its own still excludes outright, which
  // is what makes `Open,!urgent` mean "Open but not urgent" rather than "Open OR
  // not-urgent". Only an explicit `AND` puts a negation inside a group, where it
  // is one condition among several instead of a veto over the whole filter.
  const vetoes = groups.filter((g) => g.length === 1 && g[0]!.negate);
  for (const g of vetoes) {
    if (matchesTerm(value, g[0]!, members)) return false;
  }
  const required = groups.filter((g) => !(g.length === 1 && g[0]!.negate));
  if (required.length === 0) return true;
  return required.some((g) => matchesGroup(value, g, members));
}
