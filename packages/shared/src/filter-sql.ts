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

import { groupColumnFilter, parseColumnFilter, type FilterToken } from './column-filter.js';

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
  if (t.prefix || t.exact) return false; // `^NULL` / `=NULL` are literal text
  return t.term === '' || t.term.toUpperCase() === 'NULL';
}

/**
 * One token as SQL against `columnSql`.
 *
 * `negate` is applied by the caller wrapping this in `NOT (...)` rather than by
 * inverting the operator here: `NOT LIKE` does not behave like a negated LIKE
 * when the value is NULL, and the matcher's rule is that a null cell fails a
 * positive text test and therefore PASSES its negation.
 */
function tokenSql(columnSql: string, t: FilterToken): { sql: string; params: unknown[] } {
  const col = normalised(columnSql);
  if (isNullToken(t)) return { sql: `(${columnSql} IS NULL OR TRIM(${columnSql}) = '')`, params: [] };
  const term = t.term.toLowerCase();
  if (t.exact) {
    // Exact matches the WHOLE cell and is NOT trimmed (see the matcher).
    return { sql: `LOWER(${columnSql}) = ?`, params: [term] };
  }
  // ESCAPE, because a term may legitimately contain % or _.
  const like = (pattern: string) => ({ sql: `${col} LIKE ? ESCAPE '\\'`, params: [pattern] });
  const lit = term.replace(/[\\%_]/g, (c) => `\\${c}`);
  return t.prefix ? like(`${lit}%`) : like(`%${lit}%`);
}

/** A group is tokens joined by AND — they must hold of the same cell together. */
function groupSql(columnSql: string, group: FilterToken[]): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const t of group) {
    const one = tokenSql(columnSql, t);
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
export function columnFilterToSql(columnSql: string, rawFilter: string): SqlFragment {
  const raw = String(rawFilter ?? '').trim();
  if (raw === '') return { sql: '', params: [], expressible: true };
  const groups = groupColumnFilter(parseColumnFilter(raw));
  if (groups.length === 0) return { sql: '', params: [], expressible: true };

  // A group counts as negative when every token in it excludes — that is the
  // matcher's own reading of `Open,!urgent`: one positive set, one exclusion.
  const positive: string[] = [];
  const negative: string[] = [];
  const params: unknown[] = [];
  for (const group of groups) {
    const rendered = groupSql(columnSql, group);
    if (!rendered.sql) continue;
    const allNegated = group.every((t) => t.negate);
    (allNegated ? negative : positive).push(rendered.sql);
    params.push(...rendered.params);
  }

  const clauses: string[] = [];
  if (positive.length > 0) clauses.push(`(${positive.join(' OR ')})`);
  // Negatives are ANDed: every exclusion must hold.
  for (const n of negative) clauses.push(n);
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
export function buildWhere(filters: Record<string, string> | undefined, search: string | undefined, columnSqlOf: (field: string) => string | null, searchFields: readonly string[]): SqlFragment {
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
    const frag = columnFilterToSql(columnSql, raw);
    if (!frag.expressible) expressible = false;
    if (!frag.sql) continue;
    clauses.push(`(${frag.sql})`);
    params.push(...frag.params);
  }

  const term = String(search ?? '').trim();
  if (term !== '') {
    const perField: string[] = [];
    for (const field of searchFields) {
      const columnSql = columnSqlOf(field);
      if (!columnSql) {
        expressible = false;
        continue;
      }
      const frag = columnFilterToSql(columnSql, term);
      if (!frag.sql) continue;
      perField.push(`(${frag.sql})`);
      params.push(...frag.params);
    }
    // No searchable column with a SQL form: the search cannot run here at all,
    // and saying so is the difference between "no matches" and "ask me again".
    if (perField.length === 0) expressible = false;
    else clauses.push(`(${perField.join(' OR ')})`);
  }

  return { sql: clauses.join(' AND '), params, expressible };
}
