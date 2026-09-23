/**
 * The app's filter language, as SQL.
 *
 * `column-filter.ts` parses a filter expression into tokens and matches them in
 * memory; this renders the same tokens as a WHERE fragment so a backend holding
 * the rows can do the narrowing instead of shipping everything to be narrowed.
 * It is the SQL sibling of `plugins/datasette-client.ts`'s `translateQuery`,
 * which does the same job against Datasette's query parameters.
 *
 * Two rules make it safe to trust:
 *
 *  - **Every value is a bind parameter.** A filter term is user text and reaches
 *    SQL only through `?`; the returned `params` array pairs with the fragment.
 *  - **What cannot be expressed says so.** `expressible` is false when a
 *    predicate has no SQL form — a computed column, for instance, whose value
 *    exists only after a script runs. The caller then treats its rows as a
 *    SUPERSET and filters again in memory (`RowPage.partial`). Silently dropping
 *    a predicate would return rows the user excluded and look like it worked.
 *
 * The semantics mirror the matcher exactly, and the matcher is the specification:
 * case-insensitive; `NULL` means null-or-blank-after-trim; a row passes when it
 * matches at least one positive group (or there are none) and no negative one;
 * `AND` binds tighter than the comma.
 */

import { groupColumnFilter, isListExpression, parseColumnFilter, plainTextOf, type FilterToken } from './column-filter.js';
import { isValidBound } from './compare-cell.js';
import { resolveDateTerm } from './relative-date.js';

export interface SqlFragment {
  /** A boolean SQL expression, or '' when nothing needed saying. */
  sql: string;
  params: unknown[];
  /** False when at least one predicate had no SQL form and was left out. */
  expressible: boolean;
}

/** `LOWER(TRIM(x))` — the shape every comparison here comes down to. */
function normalised(columnSql: string): string {
  return `LOWER(TRIM(${columnSql}))`;
}

/** Is this token the whole-token NULL test rather than a text match? */
function isNullToken(t: FilterToken): boolean {
  // Any anchor asks for the literal text: `^NULL`, `=NULL`, `*NULL*`.
  if (t.prefix || t.exact || t.suffix || t.contains) return false;
  return t.term === '' || t.term.toUpperCase() === 'NULL';
}

/**
 * `compare-cell.ts`'s number reading, as SQL: a blank cell is `0` (`Number('')`
 * is `0`, not `NaN`), and any other cell parses only if the WHOLE trimmed text
 * is an optionally-signed decimal, optionally followed by an `e`/`E` exponent
 * (itself optionally signed) — the same grammar JS `Number()` accepts for
 * ordinary and scientific notation. Anything else is NULL.
 *
 * Plain `CAST(x AS REAL)` cannot stand in for this: SQLite takes the longest
 * numeric PREFIX of the text and treats anything with no such prefix as `0.0`
 * (`CAST('n/a' AS REAL)` is `0`, not NULL), which would let a non-numeric cell
 * satisfy a comparison the matcher fails.
 *
 * Deliberately NOT reproduced: hex/binary/octal literals (`'0x1A'`, `'0b101'`)
 * and `Infinity`/`NaN` spellings. `Number()` reads the first as a number, but
 * `compareKey` immediately rejects `Infinity` itself (`Number.isFinite`), and
 * hex/octal/binary text is not a shape `sql-mapping.ts` or any importer ever
 * writes into a `number` column — only plain decimal and scientific notation
 * are reachable in practice. A future task with a real fixture in that shape
 * should revisit this, not assume it was an oversight.
 */
function numberExpr(columnSql: string): string {
  return (
    `(SELECT CASE ` +
    `WHEN raw = '' THEN 0 ` +
    `WHEN epos = 0 AND mantissaOk THEN CAST(raw AS REAL) ` +
    `WHEN epos > 0 AND mantissaOk AND expOk THEN CAST(raw AS REAL) ` +
    `ELSE NULL END ` +
    `FROM (SELECT raw, epos, ` +
    `(mantissa <> '' AND mantissa <> '.' AND mantissa NOT GLOB '*[^0-9.]*' AND (LENGTH(mantissa) - LENGTH(REPLACE(mantissa, '.', ''))) <= 1) AS mantissaOk, ` +
    `(expBody <> '' AND expBody NOT GLOB '*[^0-9]*') AS expOk ` +
    `FROM (SELECT raw, epos, mantissa, ` +
    `CASE WHEN substr(remainder, 1, 1) IN ('+', '-') THEN substr(remainder, 2) ELSE remainder END AS expBody ` +
    `FROM (SELECT raw, epos, ` +
    `CASE WHEN epos > 0 THEN substr(body, 1, epos - 1) ELSE body END AS mantissa, ` +
    `CASE WHEN epos > 0 THEN substr(body, epos + 1) ELSE '' END AS remainder ` +
    `FROM (SELECT raw, body, INSTR(LOWER(body), 'e') AS epos ` +
    `FROM (SELECT raw, CASE WHEN substr(raw, 1, 1) IN ('+', '-') THEN substr(raw, 2) ELSE raw END AS body ` +
    `FROM (SELECT TRIM(${columnSql}) AS raw)))))))`
  );
}

/**
 * The SQL expression a comparison compares, and the bound it compares against.
 *
 * `date()` / `datetime()` are what make this agree with `compare-cell.ts`:
 * SQLite accepts ISO-8601 with a `Z` or `±HH:MM` suffix and answers in UTC,
 * which is exactly the normalisation the matcher applies.
 *
 * `valid` is false when a `date`/`datetime` bound cannot be read at all —
 * checked with `compare-cell.ts`'s own `isValidBound`, the exact reading
 * `satisfiesCmp` uses for the bound, so the two can never drift apart. The
 * caller must then short-circuit the whole token to always-false: binding an
 * unparseable bound in as raw text and comparing it lexicographically against
 * `date(col)` text can return every row instead of none, depending on which
 * side of the alphabet the malformed text happens to sort (digits sort before
 * letters, so `>=`/`>` against a bound like `not-a-date` "agree" with the
 * matcher only by accident, while `<=`/`<` return everything).
 */
function cmpOperands(columnSql: string, term: string, type: string | undefined, now: Date): { expr: string; bound: string; valid: boolean } {
  let bound = term.trim();
  if (type === 'date' || type === 'datetime') bound = resolveDateTerm(bound, now) ?? bound;
  const dateOnlyBound = /^\d{4}-\d{2}-\d{2}$/.test(bound);
  if (type === 'date' || (type === 'datetime' && dateOnlyBound)) {
    return { expr: `date(${columnSql})`, bound, valid: isValidBound(bound, 'date') };
  }
  if (type === 'datetime') return { expr: `datetime(${columnSql})`, bound, valid: isValidBound(bound, 'datetime') };
  if (type === 'number') return { expr: numberExpr(columnSql), bound, valid: true }; // validated by the caller, against `Number(bound)`
  return { expr: normalised(columnSql), bound: bound.toLowerCase(), valid: true };
}

/**
 * One token as SQL against `columnSql`.
 *
 * `negate` is applied by the caller wrapping this in `NOT (...)` rather than by
 * inverting the operator here: `NOT LIKE` does not behave like a negated LIKE
 * when the value is NULL, and the matcher's rule is that a null cell fails a
 * positive text test and therefore PASSES its negation.
 */
function tokenSql(columnSql: string, t: FilterToken, defaultSubstring: boolean, type: string | undefined, now: Date): { sql: string; params: unknown[] } {
  const col = normalised(columnSql);
  if (isNullToken(t)) return { sql: `(${columnSql} IS NULL OR TRIM(${columnSql}) = '')`, params: [] };
  if (t.cmp) {
    const { expr, bound, valid } = cmpOperands(columnSql, t.term, type, now);
    // A bound with no meaningful reading (a malformed date, say) satisfies no
    // comparison at all — `satisfiesCmp` returns false unconditionally, and
    // this reproduces that, exactly like the `number` arm below does for its
    // own unparseable bound.
    if (!valid) return { sql: '0', params: [] };
    // The IS NOT NULL / <> '' guard is the matcher's "an empty cell never
    // satisfies a comparison" — EXCEPT on a `number` column, where the matcher
    // reads a blank cell as `0` (`Number('')`), not as absent. `numberExpr`
    // already encodes that, so the blank-text guard would only make SQL
    // stricter than the matcher there and must be left out.
    const blankGuard = type === 'number' ? '' : ` AND TRIM(${columnSql}) <> ''`;
    const guard = `${columnSql} IS NOT NULL${blankGuard} AND ${expr} IS NOT NULL`;
    // A number bound binds as a number so SQLite compares numerically.
    const param: unknown = type === 'number' ? Number(bound) : bound;
    if (type === 'number' && !Number.isFinite(param as number)) return { sql: '0', params: [] };
    return { sql: `(${guard} AND ${expr} ${t.cmp} ?)`, params: [param] };
  }
  const term = t.term.toLowerCase();
  // Exact matches the WHOLE cell and is NOT trimmed (see the matcher).
  const equals = () => ({ sql: `LOWER(${columnSql}) = ?`, params: [term] });
  if (t.exact) return equals();
  // ESCAPE, because a term may legitimately contain % or _.
  const like = (pattern: string) => ({ sql: `${col} LIKE ? ESCAPE '\\'`, params: [pattern] });
  const lit = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  if (t.prefix) return like(`${lit}%`);
  if (t.suffix) return like(`%${lit}`);
  if (t.contains) return like(`%${lit}%`);
  // No anchor: the same setting the matcher reads decides. The two MUST agree —
  // `test/shared/filter-sql.test.ts` runs every case through real SQLite AND
  // through `matchesColumnFilter` and requires the same answer.
  return defaultSubstring ? like(`%${lit}%`) : equals();
}

/** A group is tokens joined by AND — they must hold of the same cell together. */
function groupSql(columnSql: string, group: FilterToken[], defaultSubstring: boolean, type: string | undefined, now: Date): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const t of group) {
    const one = tokenSql(columnSql, t, defaultSubstring, type, now);
    if (!t.negate) {
      parts.push(one.sql);
    } else if (isNullToken(t)) {
      // `!NULL` — the negation of the null test itself. A NULL row must FAIL it,
      // which plain NOT already gets right.
      parts.push(`NOT (${one.sql})`);
    } else {
      // A negated TEXT test must pass for a NULL cell, because the matcher's rule
      // is that a null cell never contains a non-empty term and therefore passes
      // its negation (`!true` on a boolean column surfaces the empty rows). SQL
      // disagrees on its own: `NOT (NULL LIKE '%x%')` is unknown, not true, so the
      // row would be dropped. The IS NULL arm restores the matcher's answer.
      parts.push(`(${columnSql} IS NULL OR NOT (${one.sql}))`);
    }
    params.push(...one.params);
  }
  return { sql: parts.length > 1 ? `(${parts.join(' AND ')})` : (parts[0] ?? ''), params };
}

/**
 * One column's filter expression as SQL.
 *
 * `columnSql` is the already-quoted SQL for the column, so the caller owns
 * identifier quoting and this function never builds one from user text.
 */
export function columnFilterToSql(columnSql: string, rawFilter: string, opts?: { defaultSubstring?: boolean | undefined; type?: string | undefined; now?: Date | undefined }): SqlFragment {
  const raw = String(rawFilter ?? '').trim();
  if (raw === '') return { sql: '', params: [], expressible: true };
  const groups = groupColumnFilter(parseColumnFilter(raw));
  if (groups.length === 0) return { sql: '', params: [], expressible: true };
  const now = opts?.now ?? new Date();

  // A group counts as negative when every token in it excludes — that is the
  // matcher's own reading of `Open,!urgent`: one positive set, one exclusion.
  //
  // Each group's params travel WITH its SQL rather than in one flat list, because
  // the clauses are re-ordered below (positives first) and `?` binds by position.
  // Collecting them in group order while emitting in clause order is what made
  // `!CC,Flat` bind `%cc%` to the positive LIKE and `%flat%` to the NOT LIKE —
  // the exact inverse of what was typed, and silent, since both are valid SQL.
  const positive: Array<{ sql: string; params: unknown[] }> = [];
  const negative: Array<{ sql: string; params: unknown[] }> = [];
  for (const group of groups) {
    const rendered = groupSql(columnSql, group, opts?.defaultSubstring ?? true, opts?.type, now);
    if (!rendered.sql) continue;
    const allNegated = group.every((t) => t.negate);
    (allNegated ? negative : positive).push(rendered);
  }

  const clauses: string[] = [];
  const params: unknown[] = [];
  if (positive.length > 0) {
    clauses.push(`(${positive.map((p) => p.sql).join(' OR ')})`);
    for (const p of positive) params.push(...p.params);
  }
  // Negatives are ANDed: every exclusion must hold.
  for (const n of negative) {
    clauses.push(n.sql);
    params.push(...n.params);
  }
  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '', params, expressible: true };
}

/**
 * A whole query's filters plus a global search, as one WHERE fragment.
 *
 * `columnSqlOf` returns the quoted SQL for a field, or null when that field has
 * no SQL form — a computed column. A filter on such a field cannot be applied
 * here, so it is omitted and `expressible` goes false, which the caller must
 * surface as `RowPage.partial` and re-filter.
 *
 * `searchFields` are the fields a bare search term looks in; the search matches
 * when ANY of them does.
 */
export function buildWhere(
  filters: Record<string, string> | undefined,
  search: string | undefined,
  columnSqlOf: (field: string) => string | null,
  searchFields: readonly string[],
  opts?: { defaultSubstring?: boolean | undefined; typeOf?: ((field: string) => string | undefined) | undefined; now?: Date | undefined },
): SqlFragment {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let expressible = true;

  for (const [field, raw] of Object.entries(filters ?? {})) {
    if (String(raw ?? '').trim() === '') continue;
    const columnSql = columnSqlOf(field);
    if (!columnSql) {
      expressible = false; // computed column — the caller re-filters
      continue;
    }
    const frag = columnFilterToSql(columnSql, raw, {
      ...(opts?.defaultSubstring === undefined ? {} : { defaultSubstring: opts.defaultSubstring }),
      ...(opts?.now ? { now: opts.now } : {}),
      ...(opts?.typeOf ? { type: opts.typeOf(field) } : {}),
    });
    if (!frag.expressible) expressible = false;
    if (!frag.sql) continue;
    clauses.push(`(${frag.sql})`);
    params.push(...frag.params);
  }

  const term = String(search ?? '').trim();
  if (term !== '') {
    const cols = searchFields.map((f) => columnSqlOf(f)).filter((c): c is string => c != null);
    if (cols.length !== searchFields.length) expressible = false;
    // No searchable column with a SQL form: the search cannot run here at all,
    // and saying so is the difference between "no matches" and "ask me again".
    if (cols.length === 0) expressible = false;
    else {
      const frag = searchToSql(cols, term, opts?.defaultSubstring ?? true);
      if (frag.sql) {
        clauses.push(`(${frag.sql})`);
        params.push(...frag.params);
      }
    }
  }

  return { sql: clauses.join(' AND '), params, expressible };
}

/**
 * A search term across SEVERAL columns — the SQL twin of `rowMatchesFilterExpr`.
 *
 * Not `columnFilterToSql` per column OR'd together, which is what this was and
 * what made an exclusion useless: the two halves of the language take different
 * quantifiers once there is more than one column to look in.
 *
 *   • a POSITIVE group is satisfied by ANY column — what a search box has always
 *     done;
 *   • an EXCLUSION must hold of EVERY column. `!CC` means "this row has no CC in
 *     it", and OR-ing the per-column form asked "is SOME column not CC", which is
 *     true of nearly every row and excluded nothing.
 *
 * The exclusion is therefore built from its own POSITIVE form and negated once,
 * on the outside, over all the columns at once.
 */
function searchToSql(cols: readonly string[], term: string, defaultSubstring: boolean): { sql: string; params: unknown[] } {
  const now = new Date();
  // Plain text rather than a list — an ordinary phrase, or the whole box quoted
  // to force it. `isListExpression` is the SAME gate `text-search.ts` applies in
  // memory, and it has to be applied here too or a windowed table would answer
  // `"Berlin, DE"` differently from a small one.
  if (!isListExpression(term)) {
    const literal = plainTextOf(term);
    // An empty literal narrows nothing — and must not reach `tokenSql`, where an
    // empty term is the NULL test rather than a match-anything.
    if (literal === '') return { sql: '', params: [] };
    const token: FilterToken = { term: literal, negate: false, contains: true };
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const col of cols) {
      const one = tokenSql(col, token, defaultSubstring, undefined, now);
      parts.push(one.sql);
      params.push(...one.params);
    }
    return { sql: parts.length > 0 ? `(${parts.join(' OR ')})` : '', params };
  }

  const groups = groupColumnFilter(parseColumnFilter(term));
  if (groups.length === 0) return { sql: '', params: [] };
  const isVeto = (g: FilterToken[]): boolean => g.length === 1 && g[0]!.negate;

  const clauses: string[] = [];
  const params: unknown[] = [];

  // Same veto rule as the matcher: a lone negative token excludes outright, so
  // `Open,!urgent` still reads as "Open but not urgent".
  for (const g of groups.filter(isVeto)) {
    const token = { ...g[0]!, negate: false };
    const parts: string[] = [];
    for (const col of cols) {
      const one = tokenSql(col, token, defaultSubstring, undefined, now);
      // A NULL cell must read as "does not contain it" rather than as unknown,
      // or `NOT (… OR NULL)` drops rows whose other columns are perfectly fine.
      // The null TOKEN tests for emptiness itself and must not be guarded.
      parts.push(isNullToken(token) ? one.sql : `(${col} IS NOT NULL AND (${one.sql}))`);
      params.push(...one.params);
    }
    if (parts.length > 0) clauses.push(`NOT (${parts.join(' OR ')})`);
  }

  const required = groups.filter((g) => !isVeto(g));
  if (required.length > 0) {
    const parts: string[] = [];
    for (const g of required) {
      for (const col of cols) {
        const one = groupSql(col, g, defaultSubstring, undefined, now);
        if (!one.sql) continue;
        parts.push(`(${one.sql})`);
        params.push(...one.params);
      }
    }
    if (parts.length > 0) clauses.push(`(${parts.join(' OR ')})`);
  }

  return { sql: clauses.join(' AND '), params };
}
