// packages/renderer/src/plugins/datasette-client.ts
//
// Pure, DOM-free client core for talking to a Datasette instance. No eda imports
// beyond shared types and the equally pure column-filter grammar; every function
// is unit-testable in isolation and reused by both the Phase-1 importer and the
// Phase-2 live DataCollection.
//
// This TypeScript build-in mirrors the runnable, unit-tested reference in
// ../../../../eda-datasette-plugin/datasette-client.js (21 node --test cases).

import type { ColumnSpec, ColumnType, TableInfo } from '@easydb/shared';
import { parseColumnFilter } from '../search/column-filter.js';
import { isInternalField } from '../util/internal-fields.js';

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
   * True when `count` is a floor, not an exact total (Datasette's
   * `count_truncated`) — the instance gave up counting past its row cap
   * (commonly ~10k rows). A progress bar using `count` as its denominator
   * must not trust it as a target in that case.
   */
  countTruncated: boolean;
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
  const u = new URL(
    `${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}.json`,
  );
  for (const [k, v] of Object.entries({ ...ref.query, ...params })) {
    if (v != null) u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Build the next page's URL from a raw `next` TOKEN, carrying `_next` as the only
 * `_`-prefixed param.
 *
 * `buildTableUrl` merges `ref.query` — the params from the URL the user pasted —
 * so a source URL that already carried `_size` would reintroduce it here and make
 * the request two-`_`-params wide. datasette.io's Cloudflare WAF challenges any
 * `.json` request like that (see fetchTableMeta), which is the exact thing this
 * path exists to avoid. Non-underscore params (real filters like `country=AFG`)
 * are kept — dropping those would silently widen the query.
 */
export function buildTokenPageUrl(ref: DatasetteRef, token: string): string {
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(ref.query)) if (!k.startsWith('_')) kept[k] = v;
  return buildTableUrl({ ...ref, query: kept }, { _next: token });
}

/**
 * Re-point a server-advertised cursor URL at the origin we actually requested.
 *
 * Datasette builds `next_url` from what IT thinks its address is. Behind a
 * TLS-terminating proxy (Fly, Heroku, a reverse proxy…) it does not know the
 * request arrived over https, so it advertises **`http://…`** — e.g.
 * til.simonwillison.net returns
 * `"next_url": "http://til.simonwillison.net/tils/similarities.json?_next=…"`.
 *
 * Fetching that from an https page is blocked outright as mixed content, and the
 * browser reports it as an opaque `TypeError` ("Load failed" / "Failed to
 * fetch") — so paging died on page two and the stored resume cursor stayed
 * un-fetchable forever. Keeping the server's path + query but OUR scheme (and
 * port) fixes it, and normalising a stored cursor the same way heals an import
 * that is already stuck.
 *
 * Returns null when the cursor points at a different host: a paging cursor that
 * hops hosts is not paging, and following it would fetch somewhere else entirely.
 */
export function normaliseCursorUrl(candidate: string, requestedUrl: string): string | null {
  try {
    const req = new URL(requestedUrl);
    const next = new URL(candidate, req);
    if (next.hostname.toLowerCase() !== req.hostname.toLowerCase()) return null;
    next.protocol = req.protocol;
    next.port = req.port;
    return next.toString();
  } catch {
    return null;
  }
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
  const rawRows: unknown[] = Array.isArray(json?.rows) ? json.rows : [];
  const cols: string[] | null = Array.isArray(json?.columns) ? json.columns : null;
  // Modern Datasette returns row objects by default; older versions return
  // positional arrays alongside a `columns` list. Normalise arrays to objects
  // so we don't have to send `_shape=objects` (which newer versions reject).
  const rows = rawRows.map((r) =>
    Array.isArray(r) && cols
      ? Object.fromEntries(cols.map((c, i) => [c, r[i]]))
      : (r as Record<string, unknown>),
  );
  return {
    rows,
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
  if (
    t.includes('REAL') ||
    t.includes('FLOA') ||
    t.includes('DOUB') ||
    t.includes('NUM') ||
    t.includes('DEC')
  ) {
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

  // `column_details` (PRAGMA table_info) may add these primary-key fields even
  // when the top-level `primary_keys` list is absent, so gather them here too.
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
    // Datasette's own hidden flag, plus storage plumbing (`rowid`) that has to
    // stay in the row for writes but is not user data.
    if (d.hidden === true || d.hidden === 1 || isInternalField(field)) spec.hidden = true;
    // Carry a column's SQL default (from column_details) so an added row starts
    // with the same value the database would use.
    if (d.default != null && d.default !== '') spec.default = d.default;
    return spec;
  });
  // Backfill the pk list from column_details when the response didn't carry a
  // top-level `primary_keys` array (older/newer shape differences).
  if (pks.length === 0) {
    const fromDetails = columns.filter((c) => c.unique).map((c) => c.field);
    if (fromDetails.length) pks.push(...fromDetails);
  }
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
  return fields.map((field) => {
    const spec: ColumnSpec = {
      field,
      label: prettifyLabel(field),
      type: inferColumnType(rows.map((r) => r[field])),
    };
    // Same rule as `mapColumns`: keep `rowid` in the data, out of sight.
    if (isInternalField(field)) spec.hidden = true;
    return spec;
  });
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
 *   >n >=n <n <=n =v *v* ^v ; bare text ⇒ __contains.
 * A comma-separated multi-token filter (see `search/column-filter.ts`) maps its
 * included values to `__in` and its `!`-negated ones to `__notin`.
 */
export function translateQuery(
  state: {
    sortColumn?: string;
    sortAsc?: boolean;
    filters?: Record<string, string>;
    search?: string;
  } = {},
): Record<string, string> {
  const params: Record<string, string> = {};
  if (state.sortColumn) params[state.sortAsc === false ? '_sort_desc' : '_sort'] = state.sortColumn;
  if (state.search) params._search = state.search;
  for (const [col, raw] of Object.entries(state.filters || {})) {
    const val = String(raw).trim();
    if (val === '') continue;
    const tokens = parseColumnFilter(val);
    // A single plain (un-negated) token keeps the comparison-operator ladder.
    if (tokens.length === 1 && !tokens[0]!.negate) {
      const one = tokens[0]!.term;
      if (tokens[0]!.prefix) {
        params[`${col}__startswith`] = one;
        continue;
      }
      let m: RegExpMatchArray | null;
      if ((m = one.match(/^>=\s*(.+)$/))) params[`${col}__gte`] = m[1]!.trim();
      else if ((m = one.match(/^<=\s*(.+)$/))) params[`${col}__lte`] = m[1]!.trim();
      else if ((m = one.match(/^>\s*(.+)$/))) params[`${col}__gt`] = m[1]!.trim();
      else if ((m = one.match(/^<\s*(.+)$/))) params[`${col}__lt`] = m[1]!.trim();
      else if ((m = one.match(/^=\s*(.+)$/))) params[`${col}__exact`] = m[1]!.trim();
      else if ((m = one.match(/^\*(.+)\*$/))) params[`${col}__contains`] = m[1]!;
      else params[`${col}__contains`] = one;
      continue;
    }
    // Datasette has one operator per column, so a `^`-anchored token mixed into
    // a multi-token set cannot be expressed: an `__in` over the OTHER included
    // values would drop the rows the anchored token was meant to add. Send no
    // param for this column and let the client-side filter narrow the page.
    if (tokens.some((t) => t.prefix)) continue;
    // Same reason for an `AND` group: `!NULL AND Biden` is two conditions on one
    // column, and Datasette takes one operator per column. The client-side
    // filter still narrows the page it does return.
    if (tokens.some((t) => t.and)) continue;
    // Multi-value / negated: include set → __in, exclude set → __notin.
    const include = tokens.filter((t) => !t.negate).map((t) => t.term);
    const exclude = tokens.filter((t) => t.negate).map((t) => t.term);
    if (include.length) params[`${col}__in`] = include.join(',');
    if (exclude.length) params[`${col}__notin`] = exclude.join(',');
  }
  return params;
}

export interface TableRef {
  db: string;
  table: string;
  count: number | null;
  hidden: boolean;
  /** Primary-key columns (from the database listing), [] if none/unknown. */
  pks: string[];
}

/**
 * Parse `/-/databases.json` into the list of database URL segments. Returns
 * each database's `route` (which can differ from its `name` — Datasette lets a
 * database be mounted at a custom route, e.g. name `fixtures2` at route
 * `alternative-route`; URLs must use the route or they 404). Skips the built-in
 * `_memory` scratch database (never has user tables). Tolerates a bare string
 * array and a `{ databases: [...] }` wrapper.
 */
export function parseDatabaseList(json: any): string[] {
  const arr = Array.isArray(json) ? json : Array.isArray(json?.databases) ? json.databases : [];
  const routes: string[] = [];
  for (const entry of arr) {
    if (typeof entry === 'string') {
      routes.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      if (entry.name === '_memory') continue;
      routes.push(typeof entry.route === 'string' && entry.route ? entry.route : entry.name);
    }
  }
  return routes;
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
      out.push({ db, table: entry, count: null, hidden: false, pks: [] });
      continue;
    }
    if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
      out.push({
        db,
        table: entry.name,
        count: typeof entry.count === 'number' ? entry.count : null,
        hidden: entry.hidden === true,
        pks: Array.isArray(entry.primary_keys) ? entry.primary_keys : [],
      });
    }
  }
  return out;
}

type FetchFn = (url: string, opts?: any) => Promise<Response>;

/**
 * Fetch a Datasette JSON endpoint with clear failure modes. Turns the three
 * ways a request can go wrong into a `DatasetteError` carrying a useful message
 * instead of an opaque `fetch` rejection ("Load failed" / "Failed to fetch"):
 *  - the request never completes (CORS block, DNS, offline, dead proxy);
 *  - it completes with an HTTP error status (redirect-to-non-CORS, 404, 500);
 *  - it returns Datasette's `{ ok:false, error }` envelope.
 */
async function fetchJson(fetchFn: FetchFn, url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    const reason = (err as Error)?.message || 'network error';
    throw new DatasetteError(
      {
        error:
          `Couldn't reach ${url} (${reason}). If this is a Datasette instance, it must be ` +
          `served with --cors for direct browser access — otherwise configure an eda sync ` +
          `server to proxy the request.`,
      },
      0,
    );
  }
  // Strict `=== false` so response doubles in tests (which omit `ok`) are fine.
  if (res && res.ok === false) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new DatasetteError(
      body && typeof body === 'object' ? body : { error: `HTTP ${res.status} for ${url}` },
      res.status,
    );
  }
  const json: any = await res.json();
  if (json && json.ok === false) throw new DatasetteError(json, res.status);
  return json;
}

/** List database names for an instance (`{base}/-/databases.json`). */
export async function fetchDatabaseNames(fetchFn: FetchFn, base: string): Promise<string[]> {
  return parseDatabaseList(await fetchJson(fetchFn, `${base}/-/databases.json`));
}

/** List tables (with counts) for one database (`{base}/{db}.json`). */
export async function fetchTablesForDb(
  fetchFn: FetchFn,
  base: string,
  db: string,
): Promise<TableRef[]> {
  return parseTableList(await fetchJson(fetchFn, `${base}/${encodeURIComponent(db)}.json`), db);
}

/** A SQL view in a Datasette database, with the query that defines it. */
export interface ViewRef {
  db: string;
  name: string;
  /** The `CREATE VIEW … AS SELECT …` statement, verbatim from sqlite_master. */
  sql: string;
}

/**
 * Parse the `views` key of `/<db>.json` into view names. Datasette returns a
 * string array; tolerate objects with a `name` (and a future `hidden` flag)
 * the same way `parseTableList` does.
 */
export function parseViewList(json: unknown): string[] {
  const views = (json as { views?: unknown } | null)?.views;
  const out: string[] = [];
  for (const entry of Array.isArray(views) ? views : []) {
    if (typeof entry === 'string') {
      out.push(entry);
      continue;
    }
    const o = entry as { name?: unknown; hidden?: unknown } | null;
    if (o && typeof o.name === 'string' && o.hidden !== true) out.push(o.name);
  }
  return out;
}

/**
 * Fetch each view's defining SQL from `sqlite_master`.
 *
 * There is no Datasette endpoint that exposes a view's definition — `/db.json`
 * names the views but not their queries — so this goes through the SQL
 * endpoint. That is a capability an instance can switch off, and plenty do, so
 * the failure is turned into a sentence the user can act on rather than a bare
 * 403.
 *
 * `_shape` is the ONLY `_`-prefixed param: two of them trip the Cloudflare
 * challenge described on `fetchTableMeta`, which poisons the whole session.
 */
export async function fetchViewDefinitions(fetchFn: FetchFn, base: string, db: string): Promise<ViewRef[]> {
  const sql = "select name, sql from sqlite_master where type='view' order by name";
  const url = `${base}/${encodeURIComponent(db)}.json?sql=${encodeURIComponent(sql)}&_shape=array`;
  let json: unknown;
  try {
    json = (await fetchJson(fetchFn, url)) as unknown;
  } catch (err) {
    const detail = err instanceof DatasetteError ? err.message : String(err);
    throw new DatasetteError(
      {
        error:
          `Couldn't read the view definitions from "${db}". Importing views needs the SQL ` +
          `endpoint, which this instance may have disabled (allow_sql). Its tables can still ` +
          `be imported normally.\n\n${detail}`,
      },
      err instanceof DatasetteError ? err.status : 0,
    );
  }
  const body = (json as { rows?: unknown } | null)?.rows;
  const rows: unknown[] = Array.isArray(json) ? json : Array.isArray(body) ? body : [];
  const out: ViewRef[] = [];
  for (const r of rows) {
    // `_shape=array` gives objects; a bare `rows` array gives positional pairs.
    const o = r as { name?: unknown; sql?: unknown } | null;
    const name = typeof o?.name === 'string' ? o.name : Array.isArray(r) ? r[0] : undefined;
    const stmt = typeof o?.sql === 'string' ? o.sql : Array.isArray(r) ? r[1] : undefined;
    if (typeof name === 'string' && typeof stmt === 'string' && stmt.trim()) out.push({ db, name, sql: stmt });
  }
  return out;
}

/**
 * Discover the views a URL refers to — one database, or every database of an
 * instance. A table URL narrows to that table's database, since a view lives
 * beside the tables it reads.
 *
 * The database listing is consulted FIRST, and the SQL endpoint is only touched
 * when that listing actually declares views. Most databases have none, and a
 * needless `?sql=` request on every import is both a wasted round trip and a
 * pointless 403 on the many instances that disable SQL — the listing's
 * `allow_execute_sql` flag is honoured for the same reason.
 */
export async function discoverViews(fetchFn: FetchFn, ref: DatasetteRef): Promise<ViewRef[]> {
  const dbs = ref.db ? [ref.db] : await fetchDatabaseNames(fetchFn, ref.base);
  const out: ViewRef[] = [];
  for (const db of dbs) {
    const listing = await fetchJson(fetchFn, `${ref.base}/${encodeURIComponent(db)}.json`);
    if (parseViewList(listing).length === 0) continue;
    if ((listing as { allow_execute_sql?: unknown } | null)?.allow_execute_sql === false) {
      throw new DatasetteError(
        {
          error:
            `"${db}" defines views, but this instance has SQL queries disabled ` +
            `(allow_execute_sql), and a view's definition can only be read through them. ` +
            `Its tables can still be imported normally.`,
        },
        403,
      );
    }
    out.push(...(await fetchViewDefinitions(fetchFn, ref.base, db)));
  }
  return out;
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
    return [{ db: ref.db, table: ref.table, count: null, hidden: false, pks: [] }];
  }
  const dbs = ref.db ? [ref.db] : await fetchDatabaseNames(fetchFn, ref.base);
  const out: TableRef[] = [];
  for (const db of dbs) {
    const tables = await fetchTablesForDb(fetchFn, ref.base, db);
    for (const t of tables) if (!t.hidden) out.push(t);
  }
  return out;
}

/**
 * Fetch a table's schema, preferring rich `column_details` (real SQLite types +
 * pk / notnull / hidden / default) and falling back to bare `columns` names.
 *
 * `_extra=column_details` is the ONLY query param on the probe. Datasette.io
 * (and other Cloudflare-fronted hosts) challenge any `.json` request carrying
 * two or more `_`-prefixed params with a 302 → Turnstile page, which then flags
 * the whole browser session so even plain row fetches get bounced — the
 * "columns show but no rows" symptom. So we can neither add `_size` nor ask for
 * `columns` in the same request (a repeated `_extra` is two `_`-params), and
 * the comma form `_extra=columns,column_details` makes older instances drop
 * BOTH extras. Modern Datasette (≈1.0) answers `column_details` with the full
 * per-column schema; older ones (e.g. datasette.io on 1.0a26) don't support it
 * and return neither it nor a `columns` list — so when the first probe yields
 * no columns we make a SECOND single-`_`-param request for `columns` to recover
 * the authoritative names (important for empty tables, where row inference
 * would find nothing). Types are refined from rows when `typed` is false.
 */
export async function fetchTableMeta(fetchFn: FetchFn, ref: DatasetteRef): Promise<TableMeta> {
  const detailsUrl = buildTableUrl(ref, { _extra: 'column_details' });
  const json: any = await fetchJson(fetchFn, detailsUrl);
  let { columns, pks } = mapColumns(json);
  let typed = !!json && json.column_details != null;
  let count: number | null = json?.count ?? null;
  let countTruncated = json?.count_truncated === true;
  let raw: unknown = json;

  if (columns.length === 0) {
    // Instance doesn't support column_details — recover the names separately.
    const colsUrl = buildTableUrl(ref, { _extra: 'columns' });
    const cjson: any = await fetchJson(fetchFn, colsUrl);
    ({ columns, pks } = mapColumns(cjson));
    typed = !!cjson && cjson.column_details != null; // still false here
    count = cjson?.count ?? count;
    countTruncated = cjson?.count_truncated === true || countTruncated;
    raw = cjson;
  }
  return { columns, pks, count, countTruncated, typed, raw };
}

/**
 * Confirm a single-table URL actually points at a real table, returning its
 * TableRef. A directly-named table has no listing to fetch, so nothing else in
 * the connect/import flow verifies it exists — without this a typo'd or missing
 * table (e.g. datasette.io/legislators/officers → "Table not found") would
 * silently create an empty local table. Uses fetchTableMeta, whose single
 * `_`-param probe stays clear of datasette.io's Cloudflare challenge and throws
 * DatasetteError on a 404, which the caller surfaces to the user.
 */
export async function probeSingleTable(fetchFn: FetchFn, ref: DatasetteRef): Promise<TableRef> {
  if (!ref.db || !ref.table) {
    throw new Error('probeSingleTable: URL must name a database and a table');
  }
  const meta = await fetchTableMeta(fetchFn, ref);
  return { db: ref.db, table: ref.table, count: meta.count, hidden: false, pks: meta.pks };
}

// -- Datasette metadata (docs.datasette.io/en/stable/metadata.html) -----------

/**
 * A table's resolved Datasette metadata, normalized to eda-friendly camelCase.
 * Everything is optional — instances may ship no metadata at all. `columns` and
 * `units` are field→text maps; `sortableColumns` is null when explicitly none,
 * undefined when unrestricted (all sortable).
 */
export interface DatasetteTableMetadata {
  sort?: string;
  sortDesc?: string;
  size?: number;
  sortableColumns?: string[] | null;
  labelColumn?: string;
  hidden?: boolean;
  description?: string;
  descriptionHtml?: string;
  source?: string;
  sourceUrl?: string;
  license?: string;
  licenseUrl?: string;
  about?: string;
  aboutUrl?: string;
  columns: Record<string, string>;
  units: Record<string, string>;
}

/**
 * Extract a table's metadata from an instance `/-/metadata.json` document,
 * layering top-level source/license/about defaults under the per-table block
 * (Datasette applies attribution top-down). Pure — no I/O.
 */
export function extractTableMetadata(
  metaJson: any,
  db: string | null,
  table: string | null,
): DatasetteTableMetadata {
  const root = metaJson && typeof metaJson === 'object' ? metaJson : {};
  const t =
    (db && table && root.databases?.[db]?.tables?.[table]) ||
    (db && table && root.databases?.[db]?.tables?.[table.toLowerCase()]) ||
    {};
  // Attribution falls back to the database and then top level.
  const dbBlock = (db && root.databases?.[db]) || {};
  const attr = (key: string): string | undefined => t[key] ?? dbBlock[key] ?? root[key];

  const out: DatasetteTableMetadata = { columns: {}, units: {} };
  if (typeof t.sort === 'string') out.sort = t.sort;
  if (typeof t.sort_desc === 'string') out.sortDesc = t.sort_desc;
  if (typeof t.size === 'number') out.size = t.size;
  if (Array.isArray(t.sortable_columns)) out.sortableColumns = t.sortable_columns.slice();
  if (typeof t.label_column === 'string') out.labelColumn = t.label_column;
  if (t.hidden === true) out.hidden = true;
  if (typeof t.description === 'string') out.description = t.description;
  if (typeof t.description_html === 'string') out.descriptionHtml = t.description_html;
  const src = attr('source');
  const srcUrl = attr('source_url');
  const lic = attr('license');
  const licUrl = attr('license_url');
  const abt = attr('about');
  const abtUrl = attr('about_url');
  if (typeof src === 'string') out.source = src;
  if (typeof srcUrl === 'string') out.sourceUrl = srcUrl;
  if (typeof lic === 'string') out.license = lic;
  if (typeof licUrl === 'string') out.licenseUrl = licUrl;
  if (typeof abt === 'string') out.about = abt;
  if (typeof abtUrl === 'string') out.aboutUrl = abtUrl;
  if (t.columns && typeof t.columns === 'object') {
    for (const [k, v] of Object.entries(t.columns)) if (typeof v === 'string') out.columns[k] = v;
  }
  if (t.units && typeof t.units === 'object') {
    for (const [k, v] of Object.entries(t.units)) if (typeof v === 'string') out.units[k] = v;
  }
  return out;
}

/** Per-instance metadata cache — `/-/metadata.json` is one blob for all tables. */
const instanceMetaCache = new Map<string, Promise<any>>();

/** Fetch (and cache) an instance's `/-/metadata.json`; `{}` if unavailable. */
export async function fetchInstanceMetadata(fetchFn: FetchFn, base: string): Promise<any> {
  let p = instanceMetaCache.get(base);
  if (!p) {
    // No `_`-prefixed params, so this is safe against the datasette.io Cloudflare
    // WAF; a missing/blocked metadata endpoint degrades to no metadata.
    p = fetchJson(fetchFn, `${base}/-/metadata.json`).catch(() => ({}));
    instanceMetaCache.set(base, p);
  }
  return p;
}

/** Fetch a table's resolved Datasette metadata (see {@link extractTableMetadata}). */
export async function fetchTableMetadata(
  fetchFn: FetchFn,
  ref: DatasetteRef,
): Promise<DatasetteTableMetadata> {
  const json = await fetchInstanceMetadata(fetchFn, ref.base);
  return extractTableMetadata(json, ref.db, ref.table);
}

/** Table fields a metadata block contributes (merged into the tables.patch). */
export interface MetadataTablePatch {
  sortColumn?: string;
  sortAsc?: boolean;
  info?: TableInfo;
  labelColumn?: string;
}

/** Build a {@link TableInfo} from metadata, or undefined when nothing to show. */
function buildTableInfo(meta: DatasetteTableMetadata): TableInfo | undefined {
  const info: TableInfo = {};
  if (meta.description != null) info.description = meta.description;
  if (meta.descriptionHtml != null) info.descriptionHtml = meta.descriptionHtml;
  if (meta.source != null) info.source = meta.source;
  if (meta.sourceUrl != null) info.sourceUrl = meta.sourceUrl;
  if (meta.license != null) info.license = meta.license;
  if (meta.licenseUrl != null) info.licenseUrl = meta.licenseUrl;
  if (meta.about != null) info.about = meta.about;
  if (meta.aboutUrl != null) info.aboutUrl = meta.aboutUrl;
  return Object.keys(info).length > 0 ? info : undefined;
}

/**
 * Apply a table's Datasette metadata onto its columns + a table patch. Grows as
 * metadata features land; today it seeds the default sort (`sort`/`sort_desc`),
 * only when the named column actually exists. The grid sorts by column type, so
 * a default sort on a numeric column sorts numerically.
 */
export function applyTableMetadata(
  meta: DatasetteTableMetadata,
  columns: ColumnSpec[],
): { columns: ColumnSpec[]; patch: MetadataTablePatch } {
  // A `sortable_columns` allowlist (any array, including empty) restricts which
  // columns the user may sort by; undefined ⇒ all sortable (leave unset).
  const sortAllow = meta.sortableColumns != null ? new Set(meta.sortableColumns) : null;

  // Per-column: description (header tooltip), units (header suffix), sortable
  // flag. Only set what metadata carries, so we never clobber an existing value.
  const outColumns = columns.map((c) => {
    const description = meta.columns[c.field];
    const units = meta.units[c.field];
    const sortable = sortAllow ? sortAllow.has(c.field) : undefined;
    if (description == null && units == null && sortable === undefined) return c;
    return {
      ...c,
      ...(description != null ? { description } : {}),
      ...(units != null ? { units } : {}),
      ...(sortable !== undefined ? { sortable } : {}),
    };
  });

  const fields = new Set(columns.map((c) => c.field));
  const patch: MetadataTablePatch = {};
  if (meta.sort && fields.has(meta.sort)) {
    patch.sortColumn = meta.sort;
    patch.sortAsc = true;
  } else if (meta.sortDesc && fields.has(meta.sortDesc)) {
    patch.sortColumn = meta.sortDesc;
    patch.sortAsc = false;
  }
  const info = buildTableInfo(meta);
  if (info) patch.info = info;
  if (meta.labelColumn && fields.has(meta.labelColumn)) patch.labelColumn = meta.labelColumn;
  return { columns: outColumns, patch };
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
  opts: {
    maxRows?: number;
    pageSize?: number | 'max';
    extraParams?: Record<string, string>;
    /** Called after each page with the running row total, for progress UIs. */
    onProgress?: (rowsSoFar: number) => void;
    /**
     * Resume paging from this exact page URL instead of building the first-page
     * URL. Used to continue an interrupted import from its stored cursor. In
     * resume mode a failure on the very first page does NOT throw — it returns
     * empty rows with `error` + `nextUrl` set, so the resume point is preserved.
     */
    startUrl?: string;
  } = {},
): Promise<{
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
  hasMore: boolean;
  pages: number;
  /**
   * Set when paging stopped early because a page hop FAILED (e.g. rate
   * limiting / HTTP 429) after at least one page had already succeeded. The
   * rows fetched so far are still returned — the caller shows a partial result
   * instead of nothing. Undefined on a clean read. A failure on the very first
   * page throws instead (there is nothing to salvage), unless `startUrl` is set.
   */
  error?: string | undefined;
  /**
   * The page URL to resume from when paging stopped short of the end — set on an
   * interruption (the failed hop) and when the row cap was hit with a live
   * cursor. Undefined when the table was read to exhaustion. Persist it to
   * resume later via `startUrl`.
   */
  nextUrl?: string | undefined;
}> {
  const maxRows = opts.maxRows ?? 10000;
  // Fixed numeric page size for predictable cursor paging. `_size=max` is also
  // valid (Datasette clamps to max_returned_rows) but a fixed size keeps page
  // hops uniform; we follow the `next` cursor to the cap either way.
  const pageSize = opts.pageSize ?? 1000;
  // `_shape` is omitted: objects are the default on modern Datasette, and
  // classifyPage normalises positional-array rows for older instances.
  const baseParams: Record<string, string | number> = {
    _size: pageSize,
    ...(opts.extraParams || {}),
  };
  const firstUrl = buildTableUrl(ref, baseParams);
  // A stored resume cursor gets the same treatment, so an import already stuck on
  // an http:// cursor recovers on the next refresh instead of failing forever.
  let url: string | null = opts.startUrl
    ? (normaliseCursorUrl(opts.startUrl, firstUrl) ?? opts.startUrl)
    : firstUrl;
  const rows: Array<Record<string, unknown>> = [];
  let truncated = false;
  let hasMore = false;
  let pages = 0;
  let error: string | undefined;
  let resumeUrl: string | undefined;

  while (url) {
    let json: any;
    try {
      json = await fetchJson(fetchFn, url);
    } catch (err) {
      // A page hop failed mid-import (commonly rate limiting / HTTP 429). Don't
      // throw away the rows already fetched — return them as a partial result
      // so the user sees what loaded, and remember where to resume. A failure on
      // the very FIRST page normally propagates (nothing salvaged), EXCEPT in
      // resume mode where the resume cursor itself is the thing that failed —
      // there we return it so the import stays resumable.
      if (rows.length === 0 && !opts.startUrl) throw err;
      error =
        err instanceof DatasetteError && err.status
          ? `stopped after ${rows.length} rows: HTTP ${err.status}`
          : `stopped after ${rows.length} rows: ${(err as Error)?.message ?? String(err)}`;
      hasMore = true; // a cursor almost certainly remained — more is available
      resumeUrl = url; // the hop that failed — resume retries it
      break;
    }
    const info = classifyPage(json);
    rows.push(...info.rows);
    truncated = truncated || info.truncated;
    pages += 1;
    opts.onProgress?.(rows.length);

    // Follow the ready-made cursor URL if present; otherwise rebuild the table
    // URL with the `next` token (datasette.io sends only the token, no next_url).
    // The rebuilt URL carries `_next` ALONE — no `_size` — so it stays a single
    // `_`-param and doesn't trip datasette.io's Cloudflare WAF (which challenges
    // any `.json` request with two or more `_`-prefixed params; see
    // fetchTableMeta). Subsequent pages fall back to Datasette's default page
    // size, which is fine — we accumulate rows to the cap regardless.
    // A server-built next_url is re-pointed at the origin we actually requested
    // (see normaliseCursorUrl — an http:// cursor from a TLS-terminated instance
    // is blocked as mixed content). If it is unusable, fall back to rebuilding
    // from the raw token rather than giving up on paging.
    const cursorUrl: string | null =
      info.nextUrl != null ? normaliseCursorUrl(info.nextUrl, url) : null;
    const nextPage: string | null =
      cursorUrl ?? (info.nextToken != null ? buildTokenPageUrl(ref, info.nextToken) : null);

    // Keep paging while there's a cursor, we're under the cap, and the page
    // actually returned rows (the last guard prevents a pathological loop on a
    // stuck token).
    if (nextPage && rows.length < maxRows && info.rows.length > 0) {
      url = nextPage;
    } else {
      // "More available" only when a live cursor remains after a page that had
      // rows — i.e. we stopped at the cap, not because the table was exhausted.
      hasMore = nextPage != null && info.rows.length > 0;
      if (hasMore) resumeUrl = nextPage ?? undefined; // cap hit — resume from here
      url = null;
    }
  }
  return { rows, truncated, hasMore, pages, error, nextUrl: resumeUrl };
}

// -- Write API (Datasette 1.0 JSON write endpoints) --------------------------
// Verified live against latest.datasette.io/ephemeral and datasette 1.0a37:
//   insert  POST {base}/{db}/{table}/-/insert          {rows,return:true}  -> {ok,rows}
//   update  POST {base}/{db}/{table}/{pk}/-/update     {update,return:true}-> {ok,rows:[row]}
//   delete  POST {base}/{db}/{table}/{pk}/-/delete     {}                  -> {ok:true}
// Writes need Authorization: Bearer dstok_… and CORS (--cors) for direct
// browser use. `<pk>` is the tilde-encoded primary key (see rowPk/tildeEncode).

export interface WriteOpts {
  /** Datasette signed token (dstok_…). Omit for anonymous (read-only) instances. */
  token?: string | undefined;
}

function writeHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function tableWriteUrl(ref: DatasetteRef, action: 'insert' | 'upsert'): string {
  return `${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}/-/${action}`;
}

function rowWriteUrl(ref: DatasetteRef, pkPath: string, action: 'update' | 'delete'): string {
  // pkPath is already tilde-encoded (URL-safe); do not re-encode it.
  return `${ref.base}/${encodeURIComponent(ref.db!)}/${encodeURIComponent(ref.table!)}/${pkPath}/-/${action}`;
}

/** POST a JSON write body and parse the {ok,…} / {ok:false,error} envelope. */
async function postWrite(
  fetchFn: FetchFn,
  url: string,
  body: unknown,
  token?: string,
): Promise<any> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: writeHeaders(token),
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new DatasetteError(
      { error: `Couldn't reach ${url} (${(err as Error)?.message || 'network error'}).` },
      0,
    );
  }
  if (res && res.ok === false) {
    let b: unknown = null;
    try {
      b = await res.json();
    } catch {
      /* non-JSON error body */
    }
    throw new DatasetteError(
      b && typeof b === 'object' ? b : { error: `HTTP ${res.status} for ${url}` },
      res.status,
    );
  }
  const json: any = await res.json();
  if (json && json.ok === false) throw new DatasetteError(json, res.status);
  return json;
}

/** Insert rows; returns the server's authoritative rows (defaults, coercion). */
export async function insertRows(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  rows: Array<Record<string, unknown>>,
  opts: WriteOpts = {},
): Promise<Array<Record<string, unknown>>> {
  const json = await postWrite(
    fetchFn,
    tableWriteUrl(ref, 'insert'),
    { rows, return: true },
    opts.token,
  );
  return Array.isArray(json?.rows) ? json.rows : [];
}

/** Update one row by tilde-encoded PK with the changed fields; returns the row. */
export async function updateRowByPk(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  pkPath: string,
  changes: Record<string, unknown>,
  opts: WriteOpts = {},
): Promise<Record<string, unknown> | null> {
  const json = await postWrite(
    fetchFn,
    rowWriteUrl(ref, pkPath, 'update'),
    { update: changes, return: true },
    opts.token,
  );
  if (json && typeof json.row === 'object' && json.row) return json.row;
  return Array.isArray(json?.rows) && json.rows[0] ? json.rows[0] : null;
}

/** Delete one row by tilde-encoded PK. */
export async function deleteRowByPk(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  pkPath: string,
  opts: WriteOpts = {},
): Promise<void> {
  await postWrite(fetchFn, rowWriteUrl(ref, pkPath, 'delete'), {}, opts.token);
}

/** Upsert rows (insert or replace by PK); returns the server's rows. */
export async function upsertRows(
  fetchFn: FetchFn,
  ref: DatasetteRef,
  rows: Array<Record<string, unknown>>,
  opts: WriteOpts = {},
): Promise<Array<Record<string, unknown>>> {
  const json = await postWrite(
    fetchFn,
    tableWriteUrl(ref, 'upsert'),
    { rows, return: true },
    opts.token,
  );
  return Array.isArray(json?.rows) ? json.rows : [];
}

// -- Connection / capability -------------------------------------------------

/** Fetch a table's primary-key columns (`?_extra=primary_keys`). [] if none. */
export async function fetchPrimaryKeys(fetchFn: FetchFn, ref: DatasetteRef): Promise<string[]> {
  // Single `_`-param only — see fetchTableMeta for why `_size` is not added.
  const url = buildTableUrl(ref, { _extra: 'primary_keys' });
  const json = await fetchJson(fetchFn, url);
  return Array.isArray(json?.primary_keys) ? json.primary_keys : [];
}

/**
 * Fetch a table's total row count via `?_extra=count` — a cheap `SELECT
 * count(*)` most instances answer even when the schema response omits `count`
 * (datasette.io does). Single `_`-param, so it's WAF-safe. `count: null` on
 * failure, so a determinate import progress bar degrades to indeterminate,
 * never errors. `truncated` mirrors Datasette's `count_truncated` — see
 * {@link TableMeta.countTruncated}.
 */
export async function fetchTableCount(
  fetchFn: FetchFn,
  ref: DatasetteRef,
): Promise<{ count: number | null; truncated: boolean }> {
  try {
    const json = await fetchJson(fetchFn, buildTableUrl(ref, { _extra: 'count' }));
    return {
      count: typeof json?.count === 'number' ? json.count : null,
      truncated: json?.count_truncated === true,
    };
  } catch {
    return { count: null, truncated: false };
  }
}

export interface ConnectionStatus {
  reachable: boolean;
  version: string | null;
  /** The authenticated actor (from `/-/actor.json`), or null if anonymous. */
  actor: Record<string, unknown> | null;
  /** A token that authenticates ⇒ treat the connection as writable. */
  writable: boolean;
  error?: string;
}

/**
 * Probe an instance: read its version and, when a token is supplied, resolve
 * the authenticated actor. `writable` is true only when a token authenticates
 * (a non-null actor) — otherwise the connection opens read-only.
 */
export async function testConnection(
  fetchFn: FetchFn,
  base: string,
  opts: WriteOpts = {},
): Promise<ConnectionStatus> {
  const init = opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : undefined;
  try {
    const vres = await fetchFn(`${base}/-/versions.json`, init);
    if (vres && vres.ok === false) {
      return {
        reachable: false,
        version: null,
        actor: null,
        writable: false,
        error: `HTTP ${vres.status}`,
      };
    }
    const vjson: any = await vres.json();
    const version = vjson?.datasette?.version ?? vjson?.version ?? null;
    let actor: Record<string, unknown> | null = null;
    try {
      const ares = await fetchFn(`${base}/-/actor.json`, init);
      const ajson: any = await ares.json();
      actor = ajson?.actor ?? null;
    } catch {
      /* actor endpoint optional */
    }
    return { reachable: true, version, actor, writable: !!(opts.token && actor) };
  } catch (err) {
    return {
      reachable: false,
      version: null,
      actor: null,
      writable: false,
      error: (err as Error)?.message || 'unreachable',
    };
  }
}

/**
 * Wrap a fetch fn so every request carries `Authorization: Bearer <token>`
 * (merged with any existing headers). Returns the fn unchanged when there's no
 * token, so anonymous/public instances are unaffected. Used for reads too, so
 * private instances (auth required to read) work, not just writes.
 */
export function withAuthFetch(fetchFn: FetchFn, token?: string): FetchFn {
  if (!token) return fetchFn;
  return (url, opts) => {
    const prev = ((opts ?? {}) as { headers?: Record<string, string> }).headers ?? {};
    return fetchFn(url, {
      ...(opts ?? {}),
      headers: { ...prev, Authorization: `Bearer ${token}` },
    });
  };
}
