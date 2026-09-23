// packages/renderer/src/search/column-filter.ts
//
// Per-column filter matching, shared by the table grid (live + faceted) and
// the read-only view windows. Pure and DOM-free so it's unit-testable.
//
// A filter is a COMMA-SEPARATED list of tokens. Each token may be negated with
// a leading `!` and/or anchored with a leading `^` (starts-with), `=` (exact
// match), or one of `>=` `<=` `>` `<` (order comparison) — these anchors are
// mutually exclusive, since a term cannot be both "starts with" and "at
// least". A row passes when it matches at least one positive token (or there
// are none) and matches no negative token:
//
//   `Sweden,Norway`      → Sweden OR Norway
//   `!Closed,!Cancelled` → everything except those two
//   `Open,!urgent`       → Open, but not the urgent ones
//   `^S`                 → cells that START WITH "S"
//   `!^S`                → cells that do NOT start with "S"
//   `=foo`               → cells that are EXACTLY "foo"
//   `!=foo`              → cells that are NOT exactly "foo"
//   `>=100`              → cells AT LEAST "100"
//   `<100`               → cells BEFORE "100"
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
//   • plain text        → the `defaultSubstring` option decides: substring by
//     default, exact when the user has turned that setting off. Every other
//     form below says which it wants and ignores the setting.
//   • `*text*`          → CONTAINS, said explicitly.
//   • `text*` / `^text` → starts-with, anchored at the first character.
//   • `*text`           → ends-with.
//   • `"text"`          → exact, when it is one entry of a LIST. The whole
//     input in quotes is not a list at all — see `isListExpression`.
//   • `=text`           → exact match against the WHOLE cell (not trimmed).
//   • `>=text` `<=text`
//     `>text` `<text`   → ORDER comparison. Lexicographic text order when no
//     column type is given (`compare-cell.ts` — type-aware comparison is a
//     later addition). False for an empty cell — a comparison against nothing
//     is not an order relation — so `!>=x` passes an empty cell the same way
//     every other negated test does.
//   • `!text`           → NOT. Because a null or empty cell never contains a
//     non-empty term, `!true` on a boolean column also surfaces the empty rows.
//   • `NULL`            → cell is null/undefined or (after trim) empty.
//   • `!NULL`           → cell has any non-empty value.
//   • `!` alone         → same as `!NULL` (cell has a value).
//   • empty query       → matches everything (no filter).
//
// `*` is a wildcard OUTSIDE quotes only, so `"a*b"` is the literal value, and a
// token that is nothing but stars stays literal too (`*` is a search for an
// asterisk, since an empty term already means "is this cell blank"). A `*`
// after a comparison anchor is likewise literal — `>=a*` compares against the
// text "a*", since the star-wildcard guard does not run once `cmp` is set.
//
// One limitation worth knowing: a BARE token whose term needs quoting (it holds
// a comma, or starts with `!`/`^`/`=`/`*`) cannot survive
// `compose → parse`, because the quotes it gains come back meaning `exact`.
// Give such a token an explicit anchor — every composer in the app already
// does, the funnel and the view pills both emitting `=`.
//
// `NULL` is matched as a whole token (case-insensitive), so a plain search for
// the literal text "null" inside a cell is intentionally not reachable — the
// null test wins. `^` and `=` both beat it: `^NULL` looks for cells starting
// with the TEXT "null", `=NULL` looks for cells that ARE exactly "null". Every
// comparison anchor beats it too: `>=NULL` compares against the literal text
// "null", not the blank test. Quote a token to search for a literal leading
// `!`, `^`, `=`, `>` or `<` (`"^caret"`).
//
// An `array` column (pass `{ type: 'array' }`) matches PER MEMBER: the cell is
// taken apart by `array-cell.ts` and a token that hits any one member hits
// the cell. `=Foo` therefore selects the rows whose list CONTAINS exactly `Foo`,
// which is what the funnel dropdown needs — its tokens are exact, and the whole
// cell (`Foo,Bar`) is never exactly one value. Negation still reads as "no
// member matches", and `NULL` as "no members at all".

import { arrayMembers } from './array-cell.js';
import { satisfiesCmp } from './compare-cell.js';

/** The four order comparisons. `>=2026-06-23`, `<100`. */
export type FilterCmp = '>' | '>=' | '<' | '<=';

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
   * `*foo` — the cell ENDS WITH the term. The one shape the grammar could not
   * express before the wildcards arrived.
   */
  suffix?: boolean;
  /**
   * `*foo*` — the cell CONTAINS the term, said explicitly.
   *
   * Distinct from a bare token with no anchor at all, which means "whichever
   * the `defaultSubstring` option says". Keeping the explicit form as its own
   * flag is what lets `composeColumnFilter` round-trip it: a bare token would
   * come back reading as the default, and the default can be off.
   */
  contains?: boolean;
  /**
   * This token is joined to the one BEFORE it with `AND`, so the two must match
   * the same cell together. It describes the separator, not the term, which is
   * why the flat token list stays the public shape: every existing consumer
   * (filter popover, view pills, the Datasette query translator) keeps reading
   * the list it already read, and only the matcher groups it.
   */
  and?: boolean;
  /**
   * `>=2026-06-23` — an ORDER comparison against the term rather than a text
   * match. Mutually exclusive with every other anchor: a term cannot be both
   * "starts with" and "at least".
   *
   * What the comparison MEANS depends on the column type and lives in
   * `compare-cell.ts`, not here.
   */
  cmp?: FilterCmp;
}

/** Is a cell value considered empty/null for filtering purposes? */
function isNullish(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

/**
 * Does this input want to be read as a LIST of include/exclude values, or as
 * one piece of plain text?
 *
 * The filter box takes both, and guessing wrong is the difference between
 * finding the rows and finding nothing. Two rules, in order:
 *
 *  1. The WHOLE input in quotes, with no other quote in it, is plain text. This
 *     is the deliberate override — the only way to search for a value that
 *     really contains a comma or a leading `!`.
 *  2. Otherwise it is a list only if it carries a mark that says so: a comma,
 *     `!`, `^`, `=`, `*`, or a standalone `AND` / `OR`. `*` and `=` are in that
 *     set because `foo*` and `=foo` mean nothing as literal text.
 *
 * Anything else is plain text, so an ordinary phrase keeps working with no
 * syntax to learn.
 */
export function isListExpression(raw: string): boolean {
  const q = String(raw ?? '').trim();
  if (q === '') return false;
  if (isFullyQuoted(q)) return false;
  return /[,!^=*<>]/.test(q) || /\s(AND|OR)(?=[\s,]|$)/.test(q);
}

/** The whole input in quotes, with no other quote inside it. */
function isFullyQuoted(q: string): boolean {
  return q.length >= 2 && q.startsWith('"') && q.endsWith('"') && (q.match(/"/g) ?? []).length === 2;
}

/**
 * The text a plain-text input is really asking for: the inner text when the
 * user quoted the whole thing, otherwise the input as typed.
 */
export function plainTextOf(raw: string): string {
  const q = String(raw ?? '').trim();
  return isFullyQuoted(q) ? q.slice(1, -1) : q;
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
  let cmp: FilterCmp | null = null;
  let atStart = true; // still eligible to consume a leading `!` / `^` / `=`
  let pendingAnd = false; // an `AND` was read; it belongs to the NEXT token

  const flush = () => {
    let term = hadQuote ? buf : buf.trim();
    // Excel's wildcard, and only outside quotes: `"a*b"` is the literal value.
    // A token that is nothing but stars keeps them as text — `*` alone is a
    // search for an asterisk, not a match-everything, because an empty term
    // already means "is this cell blank" further down.
    let star: 'contains' | 'prefix' | 'suffix' | null = null;
    if (!hadQuote && !exact && !prefix && !cmp && /[^*]/.test(term)) {
      const lead = term.startsWith('*');
      const tail = term.endsWith('*');
      if (lead && tail && term.length > 1) {
        star = 'contains';
        term = term.slice(1, -1);
      } else if (tail) {
        star = 'prefix';
        term = term.slice(0, -1);
      } else if (lead) {
        star = 'suffix';
        term = term.slice(1);
      }
    }
    if (sawText || negate) {
      const token: FilterToken = { term, negate };
      if (prefix || star === 'prefix') token.prefix = true;
      if (star === 'suffix') token.suffix = true;
      if (star === 'contains') token.contains = true;
      if (cmp) token.cmp = cmp;
      // A quoted entry in a LIST is an exact value — `"Foo Bar","Baz"` is a
      // two-value picker, not two substrings. The whole-input quoted form never
      // reaches here: `isListExpression` sends it down the plain-text path.
      if (exact || (hadQuote && !star)) token.exact = true;
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
    cmp = null;
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
    // `>` / `<`, optionally followed by `=`. Before the `=` branch, which would
    // otherwise eat the second character of `>=` as the exact-match anchor.
    if ((ch === '>' || ch === '<') && !quoted && atStart && !cmp && !prefix && !exact) {
      if (raw[i + 1] === '=') {
        cmp = `${ch}=` as FilterCmp;
        i++;
      } else {
        cmp = ch as FilterCmp;
      }
      continue;
    }
    if (ch === '=' && !quoted && atStart && !cmp && !prefix && !exact) {
      exact = true;
      continue;
    }
    if (ch === '^' && !quoted && atStart && !cmp && !prefix && !exact) {
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
  return term.includes(',') || term.includes('"') || term !== term.trim() || term === '' || term.startsWith('!') || term.startsWith('^') || term.startsWith('=') || term.startsWith('>') || term.startsWith('<') || /\s(AND|OR)(?=[\s,]|$)/.test(term);
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
    // An EXACT token whose term had to be quoted is written as the quoted form
    // alone: quotes already mean exact inside a list, so `="!bang"` would say it
    // twice and, worse, would not survive `compose → parse → compose`.
    // `^` rather than `foo*` for a prefix, because the two mean the same and the
    // anchor is what every existing composer and test already round-trips.
    const quoted = body !== t.term;
    const anchored = t.cmp ? `${t.cmp}${body}` : t.exact ? (quoted ? body : `=${body}`) : t.prefix ? `^${body}` : t.contains ? `*${body}*` : t.suffix ? `*${body}` : body;
    const text = (t.negate ? '!' : '') + anchored;
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
function matchesText(value: unknown, token: FilterToken, defaultSubstring: boolean): boolean {
  const haystack = String(value ?? '').toLowerCase();
  const needle = token.term.toLowerCase();
  if (token.exact) return haystack === needle;
  if (token.prefix) return haystack.startsWith(needle);
  if (token.suffix) return haystack.endsWith(needle);
  if (token.contains) return haystack.includes(needle);
  // No anchor of any kind: the setting decides which way a bare value leans.
  return defaultSubstring ? haystack.includes(needle) : haystack === needle;
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
function matchesTerm(value: unknown, token: FilterToken, members: string[] | null, defaultSubstring: boolean, type: string | undefined, now: Date): boolean {
  const term = token.term;
  // A comparison is an order test against the term as written — `>=NULL` looks
  // for cells at or after the literal text "null", not for blank ones.
  if (token.cmp) {
    if (members) return members.some((m) => satisfiesCmp(m, term, token.cmp!, type, now));
    return satisfiesCmp(value, term, token.cmp, type, now);
  }
  // An empty term (a lone `!`) always tests emptiness — an anchor cannot anchor
  // nothing. `NULL` tests emptiness too, unless an anchor asked for the literal
  // text.
  if (term.trim() === '') return isEmptyCell(value, members);
  if (!token.prefix && !token.exact && !token.suffix && !token.contains && term.toUpperCase() === 'NULL') {
    return isEmptyCell(value, members);
  }
  if (members) return members.some((m) => matchesText(m, token, defaultSubstring));
  return matchesText(value, token, defaultSubstring);
}

/** Does the cell satisfy every token of one AND-group? */
function matchesGroup(value: unknown, group: FilterToken[], members: string[] | null, defaultSubstring: boolean, type: string | undefined, now: Date): boolean {
  return group.every((t) => (t.negate ? !matchesTerm(value, t, members, defaultSubstring, type, now) : matchesTerm(value, t, members, defaultSubstring, type, now)));
}

/**
 * Does `value` satisfy the per-column filter `rawQuery`?
 *
 * `opts.type` is the column's type. Only `array` changes anything — it switches
 * matching to per-member (see the header). Every other type reads the cell as
 * one value, so a caller that knows no type can leave it out.
 */
export function matchesColumnFilter(value: unknown, rawQuery: string, opts?: { type?: string | undefined; defaultSubstring?: boolean | undefined; now?: Date | undefined }): boolean {
  const groups = groupColumnFilter(parseColumnFilter(rawQuery));
  if (groups.length === 0) return true;
  const members = opts?.type === 'array' ? arrayMembers(value) : null;
  const defaultSubstring = opts?.defaultSubstring ?? true;
  const type = opts?.type;
  // Resolved ONCE per call, so the two halves of `>=-3m AND <=today` cannot
  // land on different sides of midnight.
  const now = opts?.now ?? new Date();

  // A comma-separated NEGATIVE token on its own still excludes outright, which
  // is what makes `Open,!urgent` mean "Open but not urgent" rather than "Open OR
  // not-urgent". Only an explicit `AND` puts a negation inside a group, where it
  // is one condition among several instead of a veto over the whole filter.
  const vetoes = groups.filter((g) => g.length === 1 && g[0]!.negate);
  for (const g of vetoes) {
    if (matchesTerm(value, g[0]!, members, defaultSubstring, type, now)) return false;
  }
  const required = groups.filter((g) => !(g.length === 1 && g[0]!.negate));
  if (required.length === 0) return true;
  return required.some((g) => matchesGroup(value, g, members, defaultSubstring, type, now));
}
