import { describe, expect, it, vi } from 'vitest';
import type { FetchOpts } from '@easydb/shared';
import {
  parseDatabaseList,
  parseTableList,
  discoverTables,
  parseDatasetteUrl,
  classifyPage,
  fetchRows,
  normaliseCursorUrl,
  buildTokenPageUrl,
  inferColumnsFromRows,
  refineColumnTypes,
  discoverViews,
  mapColumns,
  fetchTableMeta,
  extractTableMetadata,
  applyTableMetadata,
  fetchTablesForDb,
  DatasetteError,
  insertRows,
  updateRowByPk,
  deleteRowByPk,
  upsertRows,
  fetchPrimaryKeys,
  fetchTableCount,
  testConnection,
  withAuthFetch,
  probeSingleTable,
} from '../../../packages/renderer/src/plugins/datasette-client.js';

describe('parseDatabaseList', () => {
  it('reads the pre-1.0 array of { name } objects', () => {
    const json = [
      { name: 'fixtures', path: 'fixtures' },
      { name: 'extra', path: 'extra' },
    ];
    expect(parseDatabaseList(json)).toEqual(['fixtures', 'extra']);
  });

  it('tolerates a { databases: [...] } wrapper and bare strings', () => {
    expect(parseDatabaseList({ databases: ['a', { name: 'b' }] })).toEqual(['a', 'b']);
  });

  it('returns [] for unexpected shapes', () => {
    expect(parseDatabaseList(null)).toEqual([]);
    expect(parseDatabaseList({ nope: 1 })).toEqual([]);
  });

  it('uses each database route (not name) and skips the _memory scratch db', () => {
    expect(
      parseDatabaseList({
        ok: true,
        databases: [
          { name: '_memory', route: '_memory', is_memory: true },
          { name: 'fixtures', route: 'fixtures' },
          { name: 'fixtures2', route: 'alternative-route' }, // custom mount → route ≠ name
        ],
      }),
    ).toEqual(['fixtures', 'alternative-route']);
  });
});

describe('parseTableList', () => {
  it('reads { tables: [{ name, count, hidden, primary_keys }] } and carries the db through', () => {
    const json = {
      database: 'fixtures',
      tables: [{ name: 'facetable', count: 15, hidden: false, primary_keys: ['id'] }, { name: 'searchable_fts', count: 3, hidden: true }, { name: 'no_count' }],
    };
    expect(parseTableList(json, 'fixtures')).toEqual([
      { db: 'fixtures', table: 'facetable', count: 15, hidden: false, pks: ['id'] },
      { db: 'fixtures', table: 'searchable_fts', count: 3, hidden: true, pks: [] },
      { db: 'fixtures', table: 'no_count', count: null, hidden: false, pks: [] },
    ]);
  });

  it('tolerates a bare array and string entries', () => {
    expect(parseTableList(['t1', 't2'], 'db')).toEqual([
      { db: 'db', table: 't1', count: null, hidden: false, pks: [] },
      { db: 'db', table: 't2', count: null, hidden: false, pks: [] },
    ]);
  });
});

describe('discoverTables', () => {
  const jsonRes = (body: unknown): Promise<Response> => Promise.resolve({ json: () => Promise.resolve(body) } as unknown as Response);

  it('returns just the table for a table URL (no network)', async () => {
    const fetchFn = vi.fn();
    const ref = parseDatasetteUrl('https://x.datasette.io/fixtures/facetable');
    const out = await discoverTables(fetchFn, ref);
    expect(out).toEqual([{ db: 'fixtures', table: 'facetable', count: null, hidden: false, pks: [] }]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('lists a single database and drops hidden tables', async () => {
    const fetchFn = vi.fn((url: string) => {
      expect(url).toBe('https://x.datasette.io/fixtures.json');
      return jsonRes({
        tables: [
          { name: 'facetable', count: 15, hidden: false },
          { name: 'shadow_fts', count: 0, hidden: true },
        ],
      });
    });
    const ref = parseDatasetteUrl('https://x.datasette.io/fixtures');
    const out = await discoverTables(fetchFn, ref);
    expect(out).toEqual([{ db: 'fixtures', table: 'facetable', count: 15, hidden: false, pks: [] }]);
  });

  it('walks every database for an instance URL', async () => {
    const fetchFn = vi.fn((url: string) => {
      if (url === 'https://x.datasette.io/-/databases.json') {
        return jsonRes([{ name: 'a' }, { name: 'b' }]);
      }
      if (url === 'https://x.datasette.io/a.json') {
        return jsonRes({ tables: [{ name: 't1', count: 2, hidden: false }] });
      }
      if (url === 'https://x.datasette.io/b.json') {
        return jsonRes({ tables: [{ name: 't2', count: 5, hidden: false }] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const ref = parseDatasetteUrl('https://x.datasette.io');
    const out = await discoverTables(fetchFn, ref);
    expect(out).toEqual([
      { db: 'a', table: 't1', count: 2, hidden: false, pks: [] },
      { db: 'b', table: 't2', count: 5, hidden: false, pks: [] },
    ]);
  });
});

// --- Regression: real response from datasette.io ----------------------------
// Captured from https://datasette.io/global-power-plants/global-power-plants.json
// Its defining trait: paging is signalled by a `next` TOKEN with NO `next_url`.
// An earlier classifyPage keyed only off `next_url`, so it stopped after page 1
// and silently reported a 33k-row table as "fully loaded (100 rows)".

const GPP_URL = 'https://datasette.io/global-power-plants/global-power-plants';

const GPP_PAGE1 = {
  ok: true,
  next: '100', // token → more rows available
  truncated: false,
  // (note: no `next_url` key — exactly like the real instance)
  rows: [
    {
      rowid: 1,
      country: 'AFG',
      country_long: 'Afghanistan',
      name: 'Kajaki Hydroelectric Power Plant Afghanistan',
      capacity_mw: 33.0,
      primary_fuel: 'Hydro',
      commissioning_year: null,
    },
    {
      rowid: 2,
      country: 'AFG',
      country_long: 'Afghanistan',
      name: 'Kandahar DOG',
      capacity_mw: 10.0,
      primary_fuel: 'Solar',
      commissioning_year: null,
    },
  ],
};

const GPP_PAGE2 = {
  ok: true,
  next: null, // exhausted
  truncated: false,
  rows: [{ rowid: 3, country: 'AFG', name: 'Kandahar JOL', capacity_mw: 10.0, primary_fuel: 'Solar' }],
};

const jsonRes = (body: unknown): Promise<Response> => Promise.resolve({ json: () => Promise.resolve(body) } as unknown as Response);

describe('classifyPage against the real datasette.io response', () => {
  it('detects "more available" from the `next` token even without `next_url`', () => {
    const info = classifyPage(GPP_PAGE1);
    expect(info.nextUrl).toBeNull();
    expect(info.nextToken).toBe('100');
    expect(info.hasMore).toBe(true);
    expect(info.truncated).toBe(false);
    expect(info.rows).toHaveLength(2);
  });

  it('reports exhaustion when the token is null', () => {
    const info = classifyPage(GPP_PAGE2);
    expect(info.hasMore).toBe(false);
    expect(info.nextToken).toBeNull();
  });

  it('normalises positional-array rows (older Datasette) into objects via columns', () => {
    // Response shape from an instance where the default is arrays, not objects
    // — so we can drop `_shape=objects` and still get keyed rows.
    const info = classifyPage({
      ok: true,
      next: null,
      truncated: false,
      columns: ['id', 'name'],
      rows: [
        [1, 'Alice'],
        [2, 'Bob'],
      ],
    });
    expect(info.rows).toEqual([
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ]);
  });
});

describe('normaliseCursorUrl', () => {
  const requested = 'https://til.simonwillison.net/tils/similarities.json?_size=1000';

  it('upgrades an http:// cursor from a TLS-terminated instance to our scheme', () => {
    // Verbatim from til.simonwillison.net: Datasette sits behind Fly, so it does
    // not know the request was https and advertises next_url as http://. An https
    // page cannot fetch that (mixed content is blocked → opaque "Load failed").
    expect(normaliseCursorUrl('http://til.simonwillison.net/tils/similarities.json?_next=django_pytest-django~2Emd%2Cgithub-actions_postgresq-service-container~2Emd', requested)).toBe(
      'https://til.simonwillison.net/tils/similarities.json?_next=django_pytest-django~2Emd%2Cgithub-actions_postgresq-service-container~2Emd',
    );
  });

  it('leaves an already-correct cursor alone and resolves a relative one', () => {
    expect(normaliseCursorUrl('https://til.simonwillison.net/x.json?_next=t', requested)).toBe('https://til.simonwillison.net/x.json?_next=t');
    expect(normaliseCursorUrl('/tils/similarities.json?_next=t', requested)).toBe('https://til.simonwillison.net/tils/similarities.json?_next=t');
  });

  it('refuses a cursor that hops to another host', () => {
    expect(normaliseCursorUrl('https://evil.test/x.json?_next=t', requested)).toBeNull();
    expect(normaliseCursorUrl('not a url', 'also not a url')).toBeNull();
  });
});

describe('buildTokenPageUrl', () => {
  it('carries _next alone, keeping real filters but dropping pasted _ params', () => {
    // A pasted `?_size=1000` would otherwise ride along and make the request
    // two-`_`-params wide, which datasette.io's WAF challenges.
    const ref = parseDatasetteUrl('https://til.simonwillison.net/tils/similarities?_size=1000&country=AFG');
    const url = new URL(buildTokenPageUrl(ref, 'tok'));
    expect(url.searchParams.get('_next')).toBe('tok');
    expect(url.searchParams.has('_size')).toBe(false);
    expect(url.searchParams.get('country')).toBe('AFG');
  });
});

describe('fetchRows with a TLS-terminated instance (http next_url)', () => {
  const httpsRef = () => parseDatasetteUrl('https://til.example/tils/similarities');
  const page1 = {
    rows: [{ id: 'a', other_id: 'b', score: 1 }],
    // Exactly what a Fly-hosted Datasette sends: an http:// cursor.
    next_url: 'http://til.example/tils/similarities.json?_next=tok',
    next: 'tok',
    columns: ['id', 'other_id', 'score'],
  };
  const page2 = { rows: [{ id: 'c', other_id: 'd', score: 2 }], next_url: null, next: null };

  it('follows the cursor over https, so paging does not die on page two', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      seen.push(url);
      // Mixed content never reaches the network: model the browser's block.
      if (url.startsWith('http://')) return Promise.reject(new TypeError('Load failed'));
      return jsonRes(url.includes('_next=') ? page2 : page1);
    });

    const out = await fetchRows(fetchFn, httpsRef());

    expect(out.rows).toHaveLength(2);
    expect(out.error).toBeUndefined();
    expect(seen.every((u) => u.startsWith('https://'))).toBe(true);
  });

  it('heals a stored http:// resume cursor instead of failing forever', async () => {
    const fetchFn = vi.fn((url: string) => {
      if (url.startsWith('http://')) return Promise.reject(new TypeError('Load failed'));
      return jsonRes(page2);
    });

    const out = await fetchRows(fetchFn, httpsRef(), {
      startUrl: 'http://til.example/tils/similarities.json?_next=tok',
    });

    expect(out.rows).toHaveLength(1);
    expect(out.error).toBeUndefined();
  });
});

describe('fetchRows follows the `next` token', () => {
  it('pages via ?_next=<token> and accumulates every row', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      seen.push(url);
      return jsonRes(url.includes('_next=') ? GPP_PAGE2 : GPP_PAGE1);
    });
    const ref = parseDatasetteUrl(GPP_URL);

    const out = await fetchRows(fetchFn, ref); // default numeric page size

    expect(out.rows).toHaveLength(3); // 2 + 1, not silently capped at page 1
    expect(out.pages).toBe(2);
    expect(out.hasMore).toBe(false);
    expect(out.truncated).toBe(false);
    // Second request rebuilt the table URL with the token ALONE — no `_size`
    // and no `_shape`. Keeping the follow-up to a single `_`-param avoids
    // datasette.io's Cloudflare WAF, which challenges `.json` requests carrying
    // two or more `_`-prefixed params (a `_size`+`_next` pair would 302).
    expect(seen).toHaveLength(2);
    expect(seen[1]).toContain('_next=100');
    expect(seen[1]).not.toContain('_size');
    expect(seen[1]).not.toContain('_shape');
  });

  it('stops at maxRows and honestly reports hasMore=true (capped, not complete)', async () => {
    const fetchFn = vi.fn(() => jsonRes(GPP_PAGE1)); // always says "more available"
    const ref = parseDatasetteUrl(GPP_URL);

    const out = await fetchRows(fetchFn, ref, { maxRows: 2, pageSize: 'max' });

    expect(out.rows).toHaveLength(2);
    expect(out.pages).toBe(1);
    expect(out.hasMore).toBe(true); // the importer will show the honest "capped" toast
  });

  it('keeps rows fetched before a mid-paging failure (rate limiting) instead of losing them', async () => {
    // Page 1 succeeds (2 rows, more available); the page-2 hop is rate-limited.
    const errRes = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    const fetchFn = vi.fn((url: string) => (url.includes('_next=') ? errRes(429, { ok: false, error: 'rate limited' }) : jsonRes(GPP_PAGE1)));
    const ref = parseDatasetteUrl(GPP_URL);

    const out = await fetchRows(fetchFn, ref);

    // The two rows from page 1 survive — the import shows them rather than nothing.
    expect(out.rows).toHaveLength(2);
    expect(out.pages).toBe(1);
    expect(out.hasMore).toBe(true); // a cursor remained → more is available
    expect(out.error).toMatch(/429/);
    expect(out.error).toMatch(/stopped after 2 rows/);
  });

  it('still throws when the very FIRST page fails (nothing to salvage)', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ ok: false, error: 'rate limited' }),
      } as unknown as Response),
    );
    const ref = parseDatasetteUrl(GPP_URL);

    await expect(fetchRows(fetchFn, ref)).rejects.toBeInstanceOf(DatasetteError);
  });

  it('exposes a resume cursor (nextUrl) at the hop that was interrupted', async () => {
    const errRes = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    const fetchFn = vi.fn((url: string) => (url.includes('_next=') ? errRes(429, { ok: false, error: 'rl' }) : jsonRes(GPP_PAGE1)));
    const ref = parseDatasetteUrl(GPP_URL);

    const out = await fetchRows(fetchFn, ref);
    expect(out.rows).toHaveLength(2);
    expect(out.error).toMatch(/429/);
    // The resume URL is the page-2 cursor that failed — persisted for resume.
    expect(out.nextUrl).toContain('_next=100');
  });

  it('resumes from a startUrl, continuing to the end and clearing the cursor', async () => {
    const start = `${GPP_URL}.json?_next=100`;
    const fetchFn = vi.fn(() => jsonRes(GPP_PAGE2)); // the resume page → exhausts
    const ref = parseDatasetteUrl(GPP_URL);

    const out = await fetchRows(fetchFn, ref, { startUrl: start });
    expect(fetchFn).toHaveBeenCalledWith(start); // fetched the resume cursor first
    expect(out.rows).toHaveLength(1); // just the continuation rows
    expect(out.hasMore).toBe(false);
    expect(out.error).toBeUndefined();
    expect(out.nextUrl).toBeUndefined(); // reached the end — nothing left to resume
  });

  it('in resume mode a first-page failure returns the cursor instead of throwing', async () => {
    const start = `${GPP_URL}.json?_next=100`;
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 429,
        json: () => Promise.resolve({ ok: false, error: 'rate limited' }),
      } as unknown as Response),
    );
    const ref = parseDatasetteUrl(GPP_URL);

    const out = await fetchRows(fetchFn, ref, { startUrl: start });
    expect(out.rows).toHaveLength(0);
    expect(out.error).toMatch(/429/);
    expect(out.nextUrl).toBe(start); // still resumable from the same cursor
  });
});

describe('inferColumnsFromRows (fallback when ?_extra= gives no schema)', () => {
  it('derives ordered, typed columns from the real global-power-plants rows', () => {
    const cols = inferColumnsFromRows(GPP_PAGE1.rows);
    // Order preserved (union of keys, first-seen order).
    expect(cols.map((c) => c.field)).toEqual(['rowid', 'country', 'country_long', 'name', 'capacity_mw', 'primary_fuel', 'commissioning_year']);
    const byField = Object.fromEntries(cols.map((c) => [c.field, c]));
    expect(byField.rowid!.type).toBe('number');
    expect(byField.capacity_mw!.type).toBe('number');
    expect(byField.country!.type).toBe('string');
    // All-null column defaults to string, not a bogus type.
    expect(byField.commissioning_year!.type).toBe('string');
    // Labels are prettified from snake_case.
    expect(byField.country_long!.label).toBe('Country Long');
  });

  it('does not misread an all-null column and keeps it importable', () => {
    const cols = inferColumnsFromRows([{ a: null }, { a: null }]);
    expect(cols).toEqual([{ field: 'a', label: 'A', type: 'string' }]);
  });
});

// --- Regression: real ?_extra=columns response from datasette.io ------------
// That instance answers with a BARE column-name array — no column_details, no
// primary_keys, no count. So every mapped type defaults to 'string' and must be
// refined from the separately-fetched rows. (The probe sends `_extra=columns`
// as its only param — see fetchTableMeta on why a second `_`-param would 302.)

const GPP_META = {
  ok: true,
  next: null,
  truncated: false,
  rows: [],
  columns: ['rowid', 'country', 'country_long', 'name', 'gppd_idnr', 'capacity_mw', 'latitude', 'longitude', 'primary_fuel', 'commissioning_year', 'year_of_capacity_data'],
};

describe('mapColumns / fetchTableMeta against the bare-name schema response', () => {
  it('maps a bare column-name array to columns (all string, no type info)', () => {
    const { columns, pks } = mapColumns(GPP_META);
    expect(pks).toEqual([]);
    expect(columns).toHaveLength(GPP_META.columns.length);
    expect(columns.every((c) => c.type === 'string')).toBe(true);
    expect(columns[0]).toMatchObject({ field: 'rowid', label: 'Rowid', type: 'string' });
    expect(columns.map((c) => c.field)).toEqual(GPP_META.columns);
  });

  it('probes column_details first, then falls back to columns when unsupported', async () => {
    // Model datasette.io (1.0a26): it ignores `_extra=column_details` and
    // returns neither column_details nor a columns list, so fetchTableMeta must
    // make a SECOND single-`_`-param request for `_extra=columns`.
    const seen: string[] = [];
    const noSchema = { ok: true, next: null, truncated: false, rows: [] };
    const fetchFn = vi.fn((url: string) => {
      seen.push(url);
      return jsonRes(url.includes('column_details') ? noSchema : GPP_META);
    });
    const ref = parseDatasetteUrl(GPP_URL);
    const meta = await fetchTableMeta(fetchFn, ref);
    expect(meta.typed).toBe(false);
    expect(meta.count).toBeNull();
    expect(meta.columns).toHaveLength(GPP_META.columns.length);
    // First probe is column_details; the fallback asks for columns. Each is a
    // single `_`-param request (no `_size`) so neither trips datasette.io's WAF.
    expect(seen[0]).toContain('_extra=column_details');
    expect(seen[1]).toContain('_extra=columns');
    expect(seen.every((u) => !u.includes('_size'))).toBe(true);
  });

  it('reads rich column_details into typed columns (types, pk, notnull, default)', async () => {
    // Realistic ?_extra=column_details response (latest.datasette.io shape).
    const DETAILS = {
      ok: true,
      column_details: {
        id: { sqlite_type: 'INTEGER', notnull: 1, is_pk: 1, pk_position: 1, hidden: 0 },
        name: { sqlite_type: 'TEXT', notnull: 0, is_pk: 0, hidden: 0, default: 'anon' },
        score: { sqlite_type: 'REAL', notnull: 0, is_pk: 0, hidden: 0 },
        created_at: { sqlite_type: 'TEXT', notnull: 0, is_pk: 0, hidden: 0 },
      },
    };
    const seen: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      seen.push(url);
      return jsonRes(DETAILS);
    });
    const meta = await fetchTableMeta(fetchFn, parseDatasetteUrl(GPP_URL));
    expect(meta.typed).toBe(true);
    // Only one request — column_details was enough (no columns fallback).
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('_extra=column_details');
    expect(meta.pks).toEqual(['id']);
    const byField = Object.fromEntries(meta.columns.map((c) => [c.field, c]));
    expect(byField.id).toMatchObject({ type: 'number', unique: true, notnull: true });
    expect(byField.name).toMatchObject({ type: 'string', default: 'anon' });
    expect(byField.score!.type).toBe('number');
    // created_at → datetime by the name heuristic even though SQLite stores TEXT.
    expect(byField.created_at!.type).toBe('datetime');
  });
});

describe('refineColumnTypes upgrades bare-name columns from row data', () => {
  it('turns numeric columns into number while leaving text as string', () => {
    const { columns } = mapColumns(GPP_META); // all 'string'
    const refined = refineColumnTypes(columns, GPP_PAGE1.rows);
    const byField = Object.fromEntries(refined.map((c) => [c.field, c.type]));
    expect(byField.rowid).toBe('number');
    expect(byField.capacity_mw).toBe('number');
    expect(byField.country).toBe('string');
    expect(byField.name).toBe('string');
    // A column absent from the sampled rows can't be refined — stays string.
    expect(byField.latitude).toBe('string');
    // Order + count preserved (still the schema's authoritative set).
    expect(refined.map((c) => c.field)).toEqual(columns.map((c) => c.field));
  });

  it('is a no-op when there are no rows to learn from', () => {
    const { columns } = mapColumns(GPP_META);
    expect(refineColumnTypes(columns, [])).toEqual(columns);
  });
});

// --- Regression: real ?_extra=columns,count,primary_keys response ------------
// From https://datasette.io/legislators/executive_terms.json?_extra=columns,count,primary_keys
// Notable: `count` and `primary_keys` ARE returned, but there is NO `columns`
// key and no `column_details`. So schema mapping yields nothing, and the
// importer must source columns from the rows instead — while still surfacing
// the row count for the "imported N of M" messaging.

const ET_EXTRA = {
  ok: true,
  next: '100',
  count: 131,
  primary_keys: [] as string[],
  truncated: false,
  // no `columns` key
  rows: [
    {
      rowid: 1,
      type: 'prez',
      start: '1789-04-30',
      end: '1793-03-04',
      party: 'no party',
      how: 'election',
      executive_id: 1,
    },
    {
      rowid: 3,
      type: 'viceprez',
      start: '1789-04-21',
      end: '1793-03-04',
      party: 'Federalist',
      how: 'election',
      executive_id: 2,
    },
  ],
};

describe('response carrying count + primary_keys but no columns key', () => {
  it('mapColumns yields nothing (no columns / column_details to map)', () => {
    const { columns, pks } = mapColumns(ET_EXTRA);
    expect(columns).toEqual([]);
    expect(pks).toEqual([]);
  });

  it('fetchTableMeta still surfaces the count, with typed=false and no columns', async () => {
    const fetchFn = vi.fn((_url: string) => jsonRes(ET_EXTRA));
    const meta = await fetchTableMeta(fetchFn, parseDatasetteUrl('https://datasette.io/legislators/executive_terms'));
    expect(meta.count).toBe(131);
    expect(meta.pks).toEqual([]);
    expect(meta.columns).toEqual([]);
    expect(meta.typed).toBe(false);
  });

  it("columns then come from row inference (the importer's empty-schema path)", () => {
    const byField = Object.fromEntries(inferColumnsFromRows(ET_EXTRA.rows).map((c) => [c.field, c.type]));
    expect(byField.rowid).toBe('number');
    expect(byField.executive_id).toBe('number');
    expect(byField.start).toBe('datetime');
    expect(byField.end).toBe('datetime');
    expect(byField.type).toBe('string');
    expect(byField.party).toBe('string');
  });
});

// --- Discovery failure diagnostics ------------------------------------------
// A database/instance URL that can't be reached must produce a clear, actionable
// error — not an opaque fetch rejection like "Load failed".

describe('discovery failure diagnostics', () => {
  it('turns a fetch rejection (CORS/offline) into an actionable message', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError('Load failed')));
    await expect(fetchTablesForDb(fetchFn, 'https://latest.datasette.io', 'fixtures')).rejects.toThrow(/--cors/);
    // And it names the URL it couldn't reach.
    await expect(fetchTablesForDb(fetchFn, 'https://latest.datasette.io', 'fixtures')).rejects.toThrow(/latest\.datasette\.io\/fixtures\.json/);
  });

  it('surfaces an HTTP error status (e.g. a redirect to a non-CORS URL, or 404)', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Database not found' }),
      } as unknown as Response),
    );
    const err = await fetchTablesForDb(fetchFn, 'https://x.datasette.io', 'nope').catch((e) => e);
    expect(err).toBeInstanceOf(DatasetteError);
    expect((err as DatasetteError).status).toBe(404);
    expect((err as Error).message).toContain('Database not found');
  });
});

/**
 * Readers for a recorded call's options. `FetchOpts` has every field optional
 * (a GET passes none), so these say once what each assertion means: the body was
 * sent as JSON, and the header may be absent.
 */
function sentBody(call: { opts?: FetchOpts | undefined }): unknown {
  return JSON.parse(String(call.opts?.body ?? 'null'));
}

function sentAuth(call: { opts?: FetchOpts | undefined }): string | undefined {
  return call.opts?.headers?.['Authorization'];
}

// --- Write API helpers ------------------------------------------------------
// Mapping verified live against latest.datasette.io/ephemeral (datasette 1.0a37).

function recordingFetch(responder: (call: { url: string; opts?: FetchOpts | undefined }) => unknown) {
  const calls: Array<{ url: string; opts?: FetchOpts | undefined }> = [];
  const fn = (url: string, opts?: FetchOpts) => {
    calls.push({ url, opts });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(responder({ url, opts })),
    } as unknown as Response);
  };
  return { fn, calls };
}

const WREF = parseDatasetteUrl('https://x.datasette.io/db/t');

describe('write helpers', () => {
  it('insertRows POSTs {rows,return:true} with the bearer token and returns server rows', async () => {
    const { fn, calls } = recordingFetch(() => ({ ok: true, rows: [{ id: 1, name: 'a' }] }));
    const out = await insertRows(fn, WREF, [{ name: 'a' }], { token: 'dstok_X' });
    expect(out).toEqual([{ id: 1, name: 'a' }]);
    expect(calls[0]!.url).toBe('https://x.datasette.io/db/t/-/insert');
    expect(calls[0]!.opts?.method).toBe('POST');
    expect(sentAuth(calls[0]!)).toBe('Bearer dstok_X');
    expect(calls[0]!.opts?.headers?.['Content-Type']).toBe('application/json');
    expect(sentBody(calls[0]!)).toEqual({ rows: [{ name: 'a' }], return: true });
  });

  it('updateRowByPk PUTs the changed fields to /<pk>/-/update and returns the row', async () => {
    const { fn, calls } = recordingFetch(() => ({
      ok: true,
      rows: [{ id: 5, name: 'b', qty: 99 }],
    }));
    const row = await updateRowByPk(fn, WREF, '5', { name: 'b', qty: 99 }, { token: 'dstok_Y' });
    expect(row).toEqual({ id: 5, name: 'b', qty: 99 });
    expect(calls[0]!.url).toBe('https://x.datasette.io/db/t/5/-/update');
    expect(sentBody(calls[0]!)).toEqual({
      update: { name: 'b', qty: 99 },
      return: true,
    });
  });

  it('updateRowByPk keeps a tilde-encoded compound PK verbatim in the URL', async () => {
    const { fn, calls } = recordingFetch(() => ({ ok: true, rows: [{}] }));
    await updateRowByPk(fn, WREF, 'a~2Cb,c', { x: 1 });
    expect(calls[0]!.url).toBe('https://x.datasette.io/db/t/a~2Cb,c/-/update');
  });

  it('deleteRowByPk POSTs {} to /<pk>/-/delete', async () => {
    const { fn, calls } = recordingFetch(() => ({ ok: true }));
    await deleteRowByPk(fn, WREF, '7', { token: 'dstok_Z' });
    expect(calls[0]!.url).toBe('https://x.datasette.io/db/t/7/-/delete');
    expect(calls[0]!.opts?.method).toBe('POST');
    expect(sentBody(calls[0]!)).toEqual({});
  });

  it('upsertRows POSTs to /-/upsert', async () => {
    const { fn, calls } = recordingFetch(() => ({ ok: true, rows: [{ id: 1 }] }));
    await upsertRows(fn, WREF, [{ id: 1, name: 'a' }]);
    expect(calls[0]!.url).toBe('https://x.datasette.io/db/t/-/upsert');
    expect(sentBody(calls[0]!)).toEqual({ rows: [{ id: 1, name: 'a' }], return: true });
  });

  it('omits Authorization when no token is given', async () => {
    const { fn, calls } = recordingFetch(() => ({ ok: true, rows: [] }));
    await insertRows(fn, WREF, [{ name: 'a' }]);
    expect(sentAuth(calls[0]!)).toBeUndefined();
  });

  it('throws a DatasetteError with status + message on {ok:false}', async () => {
    const fn = (_url: string, _opts?: FetchOpts) =>
      Promise.resolve({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ ok: false, error: 'Permission denied' }),
      } as unknown as Response);
    const err = await insertRows(fn, WREF, [{ name: 'a' }], { token: 'dstok_X' }).catch((e) => e);
    expect(err).toBeInstanceOf(DatasetteError);
    expect((err as DatasetteError).status).toBe(403);
    expect((err as Error).message).toContain('Permission denied');
  });
});

// --- Connection / capability ------------------------------------------------

describe('fetchPrimaryKeys', () => {
  it('reads primary_keys via ?_extra=primary_keys', async () => {
    const seen: string[] = [];
    const fetchFn = (url: string) => {
      seen.push(url);
      return jsonRes({ ok: true, primary_keys: ['id'], rows: [] });
    };
    const pks = await fetchPrimaryKeys(fetchFn, parseDatasetteUrl('https://x.datasette.io/db/t'));
    expect(pks).toEqual(['id']);
    expect(seen[0]).toContain('_extra=primary_keys');
    expect(seen[0]).not.toContain('_size'); // single `_`-param only (WAF-safe)
  });
});

describe('fetchTableCount', () => {
  const ref = parseDatasetteUrl('https://x.datasette.io/db/t');

  it('reads the row count via a single `_extra=count` param (WAF-safe)', async () => {
    const seen: string[] = [];
    const fetchFn = (url: string) => {
      seen.push(url);
      return jsonRes({ ok: true, count: 116, next: null, rows: [] });
    };
    expect(await fetchTableCount(fetchFn, ref)).toEqual({ count: 116, truncated: false });
    expect(seen[0]).toContain('_extra=count');
    expect(seen[0]).not.toContain('_size');
  });

  it('reports count_truncated when the instance gave up counting past its cap', async () => {
    const fetchFn = () => jsonRes({ ok: true, count: 10001, count_truncated: true, rows: [] });
    expect(await fetchTableCount(fetchFn, ref)).toEqual({ count: 10001, truncated: true });
  });

  it('returns a null count when absent or the request throws, never truncated', async () => {
    expect(await fetchTableCount(() => jsonRes({ ok: true, rows: [] }), ref)).toEqual({
      count: null,
      truncated: false,
    });
    expect(await fetchTableCount(() => Promise.reject(new Error('network')), ref)).toEqual({
      count: null,
      truncated: false,
    });
  });
});

describe('testConnection', () => {
  const respond = (url: string, bodies: Record<string, unknown>) => jsonRes(url.includes('/-/actor.json') ? bodies.actor : bodies.versions);

  it('resolves writable=true when a token authenticates (actor present)', async () => {
    const seen: Array<{ url: string; opts?: FetchOpts | undefined }> = [];
    const fetchFn = (url: string, opts?: FetchOpts) => {
      seen.push({ url, opts });
      return respond(url, {
        versions: { datasette: { version: '1.0a37' } },
        actor: { ok: true, actor: { id: 'root' } },
      });
    };
    const status = await testConnection(fetchFn, 'https://x.datasette.io', { token: 'dstok_X' });
    expect(status).toMatchObject({ reachable: true, version: '1.0a37', writable: true });
    expect(status.actor).toEqual({ id: 'root' });
    // The token rode on the Authorization header.
    expect(sentAuth(seen[0]!)).toBe('Bearer dstok_X');
  });

  it('resolves read-only (writable=false) with no token', async () => {
    const fetchFn = (url: string) =>
      respond(url, {
        versions: { datasette: { version: '1.0a37' } },
        actor: { ok: true, actor: null },
      });
    const status = await testConnection(fetchFn, 'https://x.datasette.io');
    expect(status.reachable).toBe(true);
    expect(status.writable).toBe(false);
  });

  it('reports unreachable when the request fails', async () => {
    const fetchFn = () => Promise.reject(new TypeError('Load failed'));
    const status = await testConnection(fetchFn, 'https://x.datasette.io', { token: 'dstok_X' });
    expect(status.reachable).toBe(false);
    expect(status.writable).toBe(false);
    expect(status.error).toContain('Load failed');
  });
});

describe('withAuthFetch', () => {
  it('injects a Bearer header and preserves existing opts/headers', async () => {
    const seen: Array<{ url: string; opts?: FetchOpts | undefined }> = [];
    const base = (url: string, opts?: FetchOpts) => {
      seen.push({ url, opts });
      return Promise.resolve({} as Response);
    };
    await withAuthFetch(base, 'dstok_X')('u', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(seen[0]!.opts?.method).toBe('POST');
    expect(seen[0]!.opts?.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer dstok_X',
    });
  });

  it('adds a headers object even when the call passed no opts (e.g. GET reads)', async () => {
    const seen: Array<{ url: string; opts?: FetchOpts | undefined }> = [];
    const base = (url: string, opts?: FetchOpts) => {
      seen.push({ url, opts });
      return Promise.resolve({} as Response);
    };
    await withAuthFetch(base, 'dstok_X')('u');
    expect(sentAuth(seen[0]!)).toBe('Bearer dstok_X');
  });

  it('returns the fn unchanged when there is no token', () => {
    const base = ((): Promise<Response> => Promise.resolve({} as Response)) as unknown as (
      url: string,
      opts?: FetchOpts,
    ) => Promise<Response>;
    expect(withAuthFetch(base, undefined)).toBe(base);
  });
});

describe('extractTableMetadata + applyTableMetadata (default sort)', () => {
  const meta = {
    source: 'Top source',
    databases: {
      db: {
        license: 'ODbL',
        tables: {
          t: {
            sort_desc: 'created',
            size: 25,
            sortable_columns: ['created', 'name'],
            label_column: 'name',
            hidden: true,
            description: 'A table',
            columns: { name: 'The name', created: 'When made' },
            units: { size: 'bytes' },
          },
        },
      },
    },
  };

  it('extracts per-table + inherited attribution, camelCased', () => {
    const m = extractTableMetadata(meta, 'db', 't');
    expect(m.sortDesc).toBe('created');
    expect(m.sort).toBeUndefined();
    expect(m.size).toBe(25);
    expect(m.sortableColumns).toEqual(['created', 'name']);
    expect(m.labelColumn).toBe('name');
    expect(m.hidden).toBe(true);
    expect(m.description).toBe('A table');
    expect(m.columns.name).toBe('The name');
    expect(m.units.size).toBe('bytes');
    expect(m.source).toBe('Top source'); // inherited from the top level
    expect(m.license).toBe('ODbL'); // inherited from the database
  });

  it('is a safe no-op for a missing / empty metadata document', () => {
    const m = extractTableMetadata({}, 'db', 't');
    expect(m.columns).toEqual({});
    expect(m.units).toEqual({});
    expect(m.sort).toBeUndefined();
  });

  it('applies sort_desc as a descending default sort when the column exists', () => {
    const cols = [
      { field: 'created', label: 'Created', type: 'number' as const },
      { field: 'name', label: 'Name', type: 'string' as const },
    ];
    const { patch } = applyTableMetadata(extractTableMetadata(meta, 'db', 't'), cols);
    expect(patch.sortColumn).toBe('created');
    expect(patch.sortAsc).toBe(false);
  });

  it('ignores a default sort naming a column that is not present', () => {
    const { patch } = applyTableMetadata({ columns: {}, units: {}, sort: 'ghost' }, [{ field: 'name', label: 'Name', type: 'string' as const }]);
    expect(patch.sortColumn).toBeUndefined();
  });
});

describe('applyTableMetadata (column descriptions + units)', () => {
  const cols = [
    { field: 'height', label: 'Height', type: 'number' as const },
    { field: 'name', label: 'Name', type: 'string' as const },
  ];
  it('attaches descriptions and units to the matching columns only', () => {
    const meta = {
      columns: { height: 'How tall', missing: 'ignored' },
      units: { height: 'metres' },
    };
    const { columns } = applyTableMetadata(meta as never, cols);
    const height = columns.find((c) => c.field === 'height')!;
    const name = columns.find((c) => c.field === 'name')!;
    expect(height.description).toBe('How tall');
    expect(height.units).toBe('metres');
    // Untouched column keeps no description/units; unknown metadata keys ignored.
    expect(name.description).toBeUndefined();
    expect(name.units).toBeUndefined();
  });
});

describe('applyTableMetadata (sortable_columns)', () => {
  const cols = [
    { field: 'a', label: 'A', type: 'string' as const },
    { field: 'b', label: 'B', type: 'string' as const },
  ];
  it('marks columns outside the allowlist as not sortable', () => {
    const { columns } = applyTableMetadata({ columns: {}, units: {}, sortableColumns: ['a'] }, cols);
    expect(columns.find((c) => c.field === 'a')!.sortable).toBe(true);
    expect(columns.find((c) => c.field === 'b')!.sortable).toBe(false);
  });
  it('an empty allowlist makes every column non-sortable', () => {
    const { columns } = applyTableMetadata({ columns: {}, units: {}, sortableColumns: [] }, cols);
    expect(columns.every((c) => c.sortable === false)).toBe(true);
  });
  it('leaves sortable unset when no allowlist is present', () => {
    const { columns } = applyTableMetadata({ columns: {}, units: {} }, cols);
    expect(columns.every((c) => c.sortable === undefined)).toBe(true);
  });
});

describe('applyTableMetadata (label_column)', () => {
  const cols = [
    { field: 'id', label: 'Id', type: 'number' as const },
    { field: 'title', label: 'Title', type: 'string' as const },
  ];
  it('records label_column when the column exists', () => {
    const { patch } = applyTableMetadata({ columns: {}, units: {}, labelColumn: 'title' }, cols);
    expect(patch.labelColumn).toBe('title');
  });
  it('ignores label_column naming a missing column', () => {
    const { patch } = applyTableMetadata({ columns: {}, units: {}, labelColumn: 'ghost' }, cols);
    expect(patch.labelColumn).toBeUndefined();
  });
});

describe('probeSingleTable', () => {
  it('throws DatasetteError when the table does not exist (404)', async () => {
    const errRes = (status: number, body: unknown): Promise<Response> =>
      Promise.resolve({
        ok: false,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    const fetchFn = vi.fn(() => errRes(404, { ok: false, error: 'Table not found: officers' }));
    const ref = parseDatasetteUrl('https://datasette.io/legislators/officers');
    await expect(probeSingleTable(fetchFn, ref)).rejects.toBeInstanceOf(DatasetteError);
  });

  it('returns a TableRef with pks and count for a real table', async () => {
    // Reuses the rich column_details shape from the fetchTableMeta tests above,
    // with a `count` added so both fields are exercised together.
    const DETAILS = {
      ok: true,
      count: 42,
      column_details: {
        id: { sqlite_type: 'INTEGER', notnull: 1, is_pk: 1, pk_position: 1, hidden: 0 },
        name: { sqlite_type: 'TEXT', notnull: 0, is_pk: 0, hidden: 0, default: 'anon' },
      },
    };
    const fetchFn = vi.fn(() => jsonRes(DETAILS));
    const ref = parseDatasetteUrl(GPP_URL);
    const result = await probeSingleTable(fetchFn, ref);
    expect(result).toEqual({
      db: 'global-power-plants',
      table: 'global-power-plants',
      count: 42,
      hidden: false,
      pks: ['id'],
    });
  });

  it('rejects a URL that is missing a table, without making any fetch', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error('should not be called')));
    const ref = parseDatasetteUrl('https://x.datasette.io/mydb');
    await expect(probeSingleTable(fetchFn, ref)).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('discoverViews', () => {
  const jsonRes = (body: unknown): Promise<Response> => Promise.resolve({ json: () => Promise.resolve(body) } as unknown as Response);

  const VIEW_SQL = 'CREATE VIEW v AS SELECT a.x AS x FROM t a';

  it('reads each view definition out of sqlite_master', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      seen.push(url);
      if (url.includes('sql=')) return jsonRes([{ name: 'v', sql: VIEW_SQL }]);
      return jsonRes({ tables: [], views: ['v'], allow_execute_sql: true });
    });
    const out = await discoverViews(fetchFn, parseDatasetteUrl('https://x.datasette.io/mydb'));
    expect(out).toEqual([{ db: 'mydb', name: 'v', sql: VIEW_SQL }]);
    // `_shape` must be the ONLY underscore param — two of them trip the
    // Cloudflare challenge that poisons the whole session.
    const sqlUrl = seen.find((u) => u.includes('sql='))!;
    expect([...new URL(sqlUrl).searchParams.keys()].filter((k) => k.startsWith('_'))).toEqual(['_shape']);
  });

  it('never touches the SQL endpoint when the listing declares no views', async () => {
    const seen: string[] = [];
    const fetchFn = vi.fn((url: string) => {
      seen.push(url);
      return jsonRes({ tables: [{ name: 't' }], views: [] });
    });
    expect(await discoverViews(fetchFn, parseDatasetteUrl('https://x.datasette.io/mydb'))).toEqual([]);
    expect(seen).toEqual(['https://x.datasette.io/mydb.json']);
  });

  it('explains itself when the instance has SQL disabled but does have views', async () => {
    const fetchFn = vi.fn(() => jsonRes({ views: ['v'], allow_execute_sql: false }));
    await expect(discoverViews(fetchFn, parseDatasetteUrl('https://x.datasette.io/mydb'))).rejects.toThrow(/allow_execute_sql/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('walks every database of an instance URL', async () => {
    const fetchFn = vi.fn((url: string) => {
      if (url.endsWith('/-/databases.json')) return jsonRes([{ name: 'a' }, { name: 'b' }]);
      if (url.includes('sql=')) return jsonRes([{ name: 'v', sql: VIEW_SQL }]);
      return jsonRes({ views: ['v'], allow_execute_sql: true });
    });
    const out = await discoverViews(fetchFn, parseDatasetteUrl('https://x.datasette.io'));
    expect(out.map((v) => v.db)).toEqual(['a', 'b']);
  });

  it('accepts the positional `rows` shape an older instance returns', async () => {
    const fetchFn = vi.fn((url: string) => {
      if (url.includes('sql=')) return jsonRes({ columns: ['name', 'sql'], rows: [['v', VIEW_SQL]] });
      return jsonRes({ views: ['v'] });
    });
    const out = await discoverViews(fetchFn, parseDatasetteUrl('https://x.datasette.io/mydb'));
    expect(out).toEqual([{ db: 'mydb', name: 'v', sql: VIEW_SQL }]);
  });
});
