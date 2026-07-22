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
  nextUrl: string | null;
  /** Cursor token (Datasette 1.0 `next`) when no absolute `next_url` is given. */
  nextToken: string | null;
  hasMore: boolean;
  truncated: boolean;
}

export interface TableMeta {
  columns: ColumnSpec[];
  pks: string[];
  count: number | null;
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
 * Read a Datasette JSON response, turning the common failure modes into a
 * DatasetteError with an explicit HTTP code and reason instead of a cryptic
 * "Unexpected token '<'" JSON parse error:
 *  - a Datasette `{ok:false,error}` body,
 *  - a non-JSON body (the request was redirected to a login/challenge page —
 *    e.g. Cloudflare Turnstile at `/-/turnstile` when the instance is
 *    rate-limiting automated requests),
 *  - a non-OK HTTP status.
 */
export async function readDatasetteJson(res: Response): Promise<any> {
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('json')) {
    let json: any;
    try {
      json = await res.json();
    } catch (e) {
      throw new DatasetteError(
        { error: `HTTP ${res.status}: invalid JSON response (${(e as Error).message})` },
        res.status,
      );
    }
    if (json && json.ok === false) throw new DatasetteError(json, res.status);
    return json;
  }
  // Not JSON — usually a redirect to a challenge/login page the browser followed.
  const url = res.url || '';
  const challenge = /\/-\/turnstile|\/cdn-cgi\/|\/-\/login/.test(url);
  const detail = challenge
    ? `blocked by a bot/rate-limit challenge (Cloudflare Turnstile) at ${url} — the Datasette instance is throttling automated requests; try again shortly or import fewer tables at once`
    : res.redirected && url
      ? `redirected to a non-JSON page (${url})`
      : `expected JSON but received ${contentType || 'a non-JSON response'}`;
  throw new DatasetteError({ error: `HTTP ${res.status}: ${detail}` }, res.status);
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

/** Build a database JSON URL (`<base>/<db>.json`) for listing its tables. */
export function buildDatabaseUrl(ref: DatasetteRef): string {
  return new URL(`${ref.base}/${encodeURIComponent(ref.db!)}.json`).toString();
}

/**
 * Extract importable table names from a Datasette database-page JSON. Tolerates
 * the shapes seen across versions: `tables` as an array of `{name, hidden}`
 * objects, an array of bare strings, or an object keyed by table name. Hidden
 * tables (FTS shadow tables, etc.) are skipped.
 */
export function extractTableNames(json: any): string[] {
  const out: string[] = [];
  const tables = json?.tables;
  if (Array.isArray(tables)) {
    for (const item of tables) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object') {
        if (item.hidden === true) continue;
        if (typeof item.name === 'string') out.push(item.name);
      }
    }
  } else if (tables && typeof tables === 'object') {
    for (const [name, meta] of Object.entries(tables)) {
      if (meta && typeof meta === 'object' && (meta as any).hidden === true) continue;
      out.push(name);
    }
  }
  return out;
}

/**
 * Like extractTableNames but also carries each table's row count (from the
 * database page's `tables[].count`). Hidden tables are skipped.
 */
export function extractTables(json: any): Array<{ name: string; count: number | null }> {
  const out: Array<{ name: string; count: number | null }> = [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const tables = json?.tables;
  if (Array.isArray(tables)) {
    for (const item of tables) {
      if (typeof item === 'string') out.push({ name: item, count: null });
      else if (item && typeof item === 'object') {
        if (item.hidden === true) continue;
        if (typeof item.name === 'string') out.push({ name: item.name, count: num(item.count) });
      }
    }
  } else if (tables && typeof tables === 'object') {
    for (const [name, meta] of Object.entries(tables)) {
      if (meta && typeof meta === 'object' && (meta as any).hidden === true) continue;
      out.push({ name, count: meta && typeof meta === 'object' ? num((meta as any).count) : null });
    }
  }
  return out;
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
 *  - hasMore:   more rows are available via paging. Older Datasette exposes an
 *    absolute `next_url`; Datasette 1.0 returns only a `next` cursor token
 *    (with no `next_url`) that must be replayed as `?_next=<token>`.
 *  - truncated: SQL/query results hard-cap at max_returned_rows with NO cursor.
 */
export function classifyPage(json: any): PageInfo {
  const nextToken = json?.next != null ? String(json.next) : null;
  const nextUrl = json?.next_url ?? null;
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
 * Infer eda ColumnSpec[] directly from materialized rows. Fallback for
 * instances whose metadata endpoint returns no `columns` (older Datasette, or
 * an `_extra` the server doesn't honor): without this, a table imports its
 * rows but shows no columns. Types are inferred from the values, with a
 * name-based date heuristic mirroring sqliteTypeToEda. Primary keys (when
 * known) are flagged unique + not-null.
 */
export function inferColumnsFromRows(
  rows: Array<Record<string, unknown>>,
  pks: string[] = [],
): ColumnSpec[] {
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
  return fields.map((field) => {
    const spec: ColumnSpec = {
      field,
      label: prettifyLabel(field),
      type: inferEdaType(
        rows.map((r) => r[field]),
        field,
      ),
    };
    if (pks.includes(field)) {
      spec.unique = true;
      spec.notnull = true;
    }
    return spec;
  });
}

function inferEdaType(values: unknown[], name: string): ColumnType {
  const samples = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (samples.length === 0) return 'string';
  if (samples.every((v) => typeof v === 'boolean')) return 'boolean';
  if (samples.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'number';
  if (
    /(_at|_date|^date$|^created$|^updated$|^modified$)$/i.test(name) &&
    samples.every((v) => !Number.isNaN(new Date(String(v)).getTime()))
  ) {
    return 'datetime';
  }
  return 'string';
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

type FetchFn = (url: string, opts?: any) => Promise<Response>;

/** Fetch a database's importable table names from its `<db>.json` page. */
export async function fetchDatabaseTables(fetchFn: FetchFn, ref: DatasetteRef): Promise<string[]> {
  const res = await fetchFn(buildDatabaseUrl(ref));
  const json: any = await readDatasetteJson(res);
  return extractTableNames(json);
}

/** Fetch a table's schema via ?_extra=columns,column_details,primary_keys,count. */
export async function fetchTableMeta(fetchFn: FetchFn, ref: DatasetteRef): Promise<TableMeta> {
  const url = buildTableUrl(ref, {
    _shape: 'objects',
    _size: 0,
    _extra: 'columns,column_details,primary_keys,count',
  });
  const res = await fetchFn(url);
  const json: any = await readDatasetteJson(res);
  const { columns, pks } = mapColumns(json);
  return { columns, pks, count: json?.count ?? null, raw: json };
}

/**
 * Materialize rows by following the paging cursor until it's exhausted or the
 * cap is reached, returning honest completeness flags (§5.3.1 of the design).
 * Handles both the old absolute `next_url` and Datasette 1.0's `next` token
 * (replayed as `?_next=<token>` against the same table URL).
 */
export async function fetchRows(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  opts: { maxRows?: number; pageSize?: number | 'max'; extraParams?: Record<string, string> } = {},
): Promise<{ rows: Array<Record<string, unknown>>; truncated: boolean; hasMore: boolean; pages: number }> {
  const maxRows = opts.maxRows ?? 10000;
  const pageSize = opts.pageSize ?? 'max';
  const baseParams = { _shape: 'objects' as const, _size: pageSize, ...(opts.extraParams || {}) };
  let url: string | null = buildTableUrl(ref, baseParams);
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  let hasMore = false;
  let pages = 0;

  while (url) {
    const res = await fetchFn(url);
    const json: any = await readDatasetteJson(res);
    const info = classifyPage(json);
    rows.push(...info.rows);
    truncated = truncated || info.truncated;
    pages += 1;

    if ((info.nextUrl || info.nextToken) && rows.length < maxRows) {
      url = info.nextUrl
        ? ensureParams(info.nextUrl, { _shape: 'objects' })
        : buildTableUrl(ref, { ...baseParams, _next: info.nextToken as string });
    } else {
      hasMore = info.nextUrl != null || info.nextToken != null;
      url = null;
    }
  }
  return { rows, truncated, hasMore, pages };
}
