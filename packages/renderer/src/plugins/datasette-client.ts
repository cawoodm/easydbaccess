// packages/renderer/src/plugins/datasette-client.ts
//
// Pure, DOM-free client core for talking to a Datasette instance. No eda imports
// beyond shared types; every function is unit-testable in isolation and reused by
// both the Phase-1 importer and the Phase-2 live DataCollection.
//
// This TypeScript build-in mirrors the runnable, unit-tested reference in
// ../../../../eda-datasette-plugin/datasette-client.js (21 node --test cases).

import type { ColumnSpec, ColumnType } from '@easydb/shared';

export interface DatasetteRef {
  base: string;
  db: string | null;
  table: string | null;
  query: Record<string, string>;
}

export interface PageInfo {
  rows: Array<Record<string, unknown>>;
  /** Ready-made absolute cursor URL, when the instance provides one. */
  nextUrl: string | null;
  /** Raw cursor token (`next`), which some instances send instead of `next_url`. */
  nextToken: string | null;
  hasMore: boolean;
  truncated: boolean;
}

export interface TableMeta {
  columns: ColumnSpec[];
  pks: string[];
  count: number | null;
  /**
   * Whether the response carried real per-column type info (`column_details`).
   * When false the columns are just names (every type defaulted to 'string')
   * and the caller should refine types from row data — some instances answer
   * `?_extra=columns` with a bare name array and ignore `column_details`.
   */
  typed: boolean;
  raw: unknown;
}

/** Error carrying Datasette's uniform {ok:false,error,errors,status} shape. */
export class DatasetteError extends Error {
  status?: number;
  errors: string[];
  constructor(body: any, status?: number) {
    const msg =
      body?.error || (body?.errors && body.errors.join('; ')) || 'Datasette request failed';
    super(msg);
    this.name = 'DatasetteError';
    this.status = status ?? body?.status;
    this.errors = body?.errors || (body?.error ? [body.error] : []);
  }
}

/**
 * Parse any Datasette URL into {base, db, table, query}. Accepts instance root,
 * database, table, ".json" links and links with filters. A mount prefix is
 * absorbed into `base`; single-segment URLs are treated as a database.
 */
export function parseDatasetteUrl(input: string): DatasetteRef {
  const u = new URL(String(input).trim());
  u.pathname = u.pathname.replace(/\.(json|csv)$/i, '');
  const segments = u.pathname.split('/').filter(Boolean);
  const query: Record<string, string> = {};
  for (const [k, v] of u.searchParams) query[k] = v;

  let base: string;
  let db: string | null = null;
  let table: string | null = null;
  if (segments.length >= 2) {
    table = decodeURIComponent(segments[segments.length - 1]!);
    db = decodeURIComponent(segments[segments.length - 2]!);
    const prefix = segments.slice(0, segments.length - 2).join('/');
    base = u.origin + (prefix ? '/' + prefix : '');
  } else if (segments.length === 1) {
    db = decodeURIComponent(segments[0]!);
    base = u.origin;
  } else {
    base = u.origin;
  }
  return { base, db, table, query };
}

/** Build a table JSON URL from a ref + extra query params. */
export function buildTableUrl(
  ref: DatasetteRef,
  params: Record<string, string | number | undefined> = {},
): string {
  const u = new URL(`${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}.json`);
  for (const [k, v] of Object.entries({ ...ref.query, ...params })) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/** Ensure a URL (e.g. a next_url) carries the given params without overwriting. */
export function ensureParams(urlStr: string, params: Record<string, string | number>): string {
  const u = new URL(urlStr);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && !u.searchParams.has(k)) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Classify a Datasette JSON response: did we get everything?
 *  - hasMore:   table endpoints signal more rows via a `next_url` cursor URL
 *               and/or a raw `next` token. Some instances (e.g. datasette.io)
 *               send only the token, so we honour either.
 *  - truncated: SQL/query results hard-cap at max_returned_rows with NO cursor.
 */
export function classifyPage(json: any): PageInfo {
  const nextUrl = json?.next_url ?? null;
  const rawNext = json?.next;
  const nextToken = rawNext != null && rawNext !== false ? String(rawNext) : null;
  return {
    rows: Array.isArray(json?.rows) ? json.rows : [],
    nextUrl,
    nextToken,
    hasMore: nextUrl != null || nextToken != null,
    truncated: json?.truncated === true,
  };
}

/** Map a SQLite storage type (+ column name) to an eda ColumnType. */
export function sqliteTypeToEda(sqliteType: string | undefined, name = ''): ColumnType {
  const t = String(sqliteType || '').toUpperCase();
  if (t.includes('INT')) {
    if (/^(is|has|can)_|_flag$|^enabled$|^active$/i.test(name)) return 'boolean';
    return 'number';
  }
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB') || t.includes('NUM') || t.includes('DEC')) {
    return 'number';
  }
  if (t.includes('BLOB')) return 'string';
  if (/(_at|_date|^date$|^created$|^updated$|^modified$)$/i.test(name)) return 'datetime';
  return 'string';
}

/**
 * Build eda ColumnSpec[] + primary-key list from a Datasette table's metadata
 * (?_extra=columns,column_details,primary_keys). Tolerates column_details as
 * either an array of {column|name,...} or an object keyed by column name.
 */
export function mapColumns(meta: any): { columns: ColumnSpec[]; pks: string[] } {
  const pks: string[] = Array.isArray(meta?.primary_keys) ? meta.primary_keys.slice() : [];
  const names: string[] = Array.isArray(meta?.columns) ? meta.columns.slice() : [];

  const details: Record<string, any> = {};
  const cd = meta?.column_details;
  if (Array.isArray(cd)) {
    for (const d of cd) details[d.column ?? d.name] = d;
  } else if (cd && typeof cd === 'object') {
    Object.assign(details, cd);
  }
  for (const n of names) if (!(n in details)) details[n] = {};
  const order = names.length ? names : Object.keys(details);

  const columns: ColumnSpec[] = order.map((field) => {
    const d = details[field] || {};
    const isPk = d.is_pk === true || d.is_pk === 1 || pks.includes(field);
    const spec: ColumnSpec = {
      field,
      label: prettifyLabel(field),
      type: sqliteTypeToEda(d.sqlite_type ?? d.type, field),
    };
    if (d.notnull === true || d.notnull === 1 || isPk) spec.notnull = true;
    if (isPk) spec.unique = true;
    if (d.hidden === true) spec.hidden = true;
    return spec;
  });
  return { columns, pks };
}

function prettifyLabel(field: string): string {
  return String(field)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Infer eda columns from materialized rows. This is the fallback when a table's
 * schema endpoint (`?_extra=columns,column_details,...`) yields nothing —
 * older Datasette instances that don't support `_extra` still return row data,
 * and a table with data but no column definitions renders blank. Column order
 * is the union of keys in first-seen order; types come from the values.
 */
export function inferColumnsFromRows(rows: Array<Record<string, unknown>>): ColumnSpec[] {
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        fields.push(k);
      }
    }
  }
  return fields.map((field) => ({
    field,
    label: prettifyLabel(field),
    type: inferColumnType(rows.map((r) => r[field])),
  }));
}

function inferColumnType(values: unknown[]): ColumnType {
  const samples = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (samples.length === 0) return 'string';
  if (samples.every((v) => typeof v === 'boolean')) return 'boolean';
  if (samples.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'number';
  if (samples.every((v) => typeof v === 'string' && isIsoDateish(v))) return 'datetime';
  return 'string';
}

/** Conservative ISO-8601-ish check — never treats a bare number as a date. */
function isIsoDateish(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(s);
}

/**
 * Tilde-encode a value for a Datasette row-PK URL segment. Any char outside
 * [A-Za-z0-9_-] becomes ~XX (uppercase hex of the UTF-8 byte). Browser-safe.
 */
export function tildeEncode(value: unknown): string {
  const bytes = new TextEncoder().encode(String(value));
  let out = '';
  for (const b of bytes) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9_-]/.test(c)) out += c;
    else out += '~' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Compute the URL path segment (and synthetic eda Row.id) for a row's PK. */
export function rowPk(rowData: Record<string, unknown>, pks: string[]): string | null {
  if (!pks || pks.length === 0) return null;
  return pks.map((k) => tildeEncode(rowData[k])).join(',');
}

/**
 * Translate an eda table's persisted sort + column filters into Datasette query
 * params (Phase-2 server-side windowing). Filter mini-language:
 *   >n >=n <n <=n =v *v* a,b,c ; bare text ⇒ __contains.
 */
export function translateQuery(state: {
  sortColumn?: string;
  sortAsc?: boolean;
  filters?: Record<string, string>;
  search?: string;
} = {}): Record<string, string> {
  const params: Record<string, string> = {};
  if (state.sortColumn) params[state.sortAsc === false ? '_sort_desc' : '_sort'] = state.sortColumn;
  if (state.search) params._search = state.search;
  for (const [col, raw] of Object.entries(state.filters || {})) {
    const val = String(raw).trim();
    if (val === '') continue;
    let m: RegExpMatchArray | null;
    if ((m = val.match(/^>=\s*(.+)$/))) params[`${col}__gte`] = m[1]!.trim();
    else if ((m = val.match(/^<=\s*(.+)$/))) params[`${col}__lte`] = m[1]!.trim();
    else if ((m = val.match(/^>\s*(.+)$/))) params[`${col}__gt`] = m[1]!.trim();
    else if ((m = val.match(/^<\s*(.+)$/))) params[`${col}__lt`] = m[1]!.trim();
    else if ((m = val.match(/^=\s*(.+)$/))) params[`${col}__exact`] = m[1]!.trim();
    else if ((m = val.match(/^\*(.+)\*$/))) params[`${col}__contains`] = m[1]!;
    else if (val.includes(',')) params[`${col}__in`] = val;
    else params[`${col}__contains`] = val;
  }
  return params;
}

export interface TableRef {
  db: string;
  table: string;
  count: number | null;
  hidden: boolean;
}

/**
 * Parse `/-/databases.json` into a list of database names. Datasette (<1.0)
 * returns an array of `{ name, ... }`; tolerate a bare string array and a
 * `{ databases: [...] }` wrapper too.
 */
export function parseDatabaseList(json: any): string[] {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.databases) ? json.databases : [];
  const names: string[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry && typeof entry === 'object' && typeof entry.name === 'string') names.push(entry.name);
  }
  return names;
}

/**
 * Parse `/<db>.json` into a list of tables with row counts. Datasette (<1.0)
 * returns `{ tables: [{ name, count, hidden }, ...] }`; tolerate a bare array,
 * a string array, and missing count/hidden fields.
 */
export function parseTableList(json: any, db: string): TableRef[] {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.tables) ? json.tables : [];
  const out: TableRef[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      out.push({ db, table: entry, count: null, hidden: false });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      out.push({
        db,
        table: entry.name,
        count: typeof entry.count === 'number' ? entry.count : null,
        hidden: entry.hidden === true,
      });
    }
  }
  return out;
}

type FetchFn = (url: string, opts?: any) => Promise<Response>;

/** List database names for an instance (`{base}/-/databases.json`). */
export async function fetchDatabaseNames(fetchFn: FetchFn, base: string): Promise<string[]> {
  const res = await fetchFn(`${base}/-/databases.json`);
  const json: any = await res.json();
  if (json && json.ok === false) throw new DatasetteError(json, res.status);
  return parseDatabaseList(json);
}

/** List tables (with counts) for one database (`{base}/{db}.json`). */
export async function fetchTablesForDb(
  fetchFn: FetchFn,
  base: string,
  db: string,
): Promise<TableRef[]> {
  const res = await fetchFn(`${base}/${encodeURIComponent(db)}.json`);
  const json: any = await res.json();
  if (json && json.ok === false) throw new DatasetteError(json, res.status);
  return parseTableList(json, db);
}

/**
 * Discover the importable tables a URL refers to:
 *  - table URL  (db + table) → just that table (count unknown here);
 *  - database URL (db only)   → every table in that database;
 *  - instance URL (neither)   → every table across every database.
 * Hidden tables (FTS shadow tables etc.) are excluded.
 */
export async function discoverTables(fetchFn: FetchFn, ref: DatasetteRef): Promise<TableRef[]> {
  if (ref.db && ref.table) {
    return [{ db: ref.db, table: ref.table, count: null, hidden: false }];
  }
  const dbs = ref.db ? [ref.db] : await fetchDatabaseNames(fetchFn, ref.base);
  const out: TableRef[] = [];
  for (const db of dbs) {
    const tables = await fetchTablesForDb(fetchFn, ref.base, db);
    for (const t of tables) if (!t.hidden) out.push(t);
  }
  return out;
}

/** Fetch a table's schema via ?_extra=columns,column_details,primary_keys,count. */
export async function fetchTableMeta(fetchFn: FetchFn, ref: DatasetteRef): Promise<TableMeta> {
  const url = buildTableUrl(ref, {
    _shape: 'objects',
    _size: 0,
    _extra: 'columns,column_details,primary_keys,count',
  });
  const res = await fetchFn(url);
  const json: any = await res.json();
  if (json && json.ok === false) throw new DatasetteError(json, res.status);
  const { columns, pks } = mapColumns(json);
  const typed = !!json && json.column_details != null;
  return { columns, pks, count: json?.count ?? null, typed, raw: json };
}

/**
 * Upgrade column types from sampled rows when the schema came back as bare
 * names (no `column_details`, so every type defaulted to 'string'). Keeps the
 * authoritative names/labels/pk flags from the schema; only a column still
 * typed 'string' is reconsidered, and only upgraded when the rows agree on a
 * more specific type. No-op when there are no rows to learn from.
 */
export function refineColumnTypes(
  columns: ColumnSpec[],
  rows: Array<Record<string, unknown>>,
): ColumnSpec[] {
  if (rows.length === 0) return columns;
  const inferred = new Map(inferColumnsFromRows(rows).map((c) => [c.field, c.type]));
  return columns.map((c) => {
    if (c.type !== 'string') return c;
    const t = inferred.get(c.field);
    return t && t !== 'string' ? { ...c, type: t } : c;
  });
}

/**
 * Materialize rows by following `next_url` until the cursor is exhausted or the
 * cap is reached, returning honest completeness flags (§5.3.1 of the design).
 */
export async function fetchRows(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  opts: { maxRows?: number; pageSize?: number | 'max'; extraParams?: Record<string, string> } = {},
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean; hasMore: boolean; pages: number }> {
  const maxRows = opts.maxRows ?? 10000;
  const pageSize = opts.pageSize ?? 'max';
  const baseParams: Record<string, string | number> = {
    _shape: 'objects',
    _size: pageSize,
    ...(opts.extraParams || {}),
  };
  let url: string | null = buildTableUrl(ref, baseParams);
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  let hasMore = false;
  let pages = 0;

  while (url) {
    const res = await fetchFn(url);
    const json: any = await res.json();
    if (json && json.ok === false) throw new DatasetteError(json, res.status);
    const info = classifyPage(json);
    rows.push(...info.rows);
    truncated = truncated || info.truncated;
    pages += 1;

    // Follow the ready-made cursor URL if present; otherwise rebuild the table
    // URL with the `next` token (datasette.io sends only the token, no next_url).
    const nextPage =
      info.nextUrl != null
        ? ensureParams(info.nextUrl, { _shape: 'objects' })
        : info.nextToken != null
          ? buildTableUrl(ref, { ...baseParams, _next: info.nextToken })
          : null;

    // Keep paging while there's a cursor, we're under the cap, and the page
    // actually returned rows (the last guard prevents a pathological loop on a
    // stuck token).
    if (nextPage && rows.length < maxRows && info.rows.length > 0) {
      url = nextPage;
    } else {
      // "More available" only when a live cursor remains after a page that had
      // rows — i.e. we stopped at the cap, not because the table was exhausted.
      hasMore = nextPage != null && info.rows.length > 0;
      url = null;
    }
  }
  return { rows, truncated, hasMore, pages };
}
