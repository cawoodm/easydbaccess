import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { buildWhere, columnFilterToSql } from '../../packages/shared/src/filter-sql.js';
import { matchesColumnFilter } from '../../packages/shared/src/column-filter.js';

/**
 * The SQL translation has one job: agree with the in-memory matcher.
 *
 * The matcher IS the specification — it is what the grid, the view windows and
 * every existing consumer already do — so these tests run each filter BOTH ways
 * over the same values, against a real SQLite database, and require the same
 * answer. Asserting the generated SQL text instead would only prove it matches
 * itself.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

/** The awkward cases: nulls, blanks, mixed case, punctuation, SQL wildcards. */
const VALUES: Array<string | null> = ['Sweden', 'sweden', 'Norway', 'Switzerland', 'Berlin, DE', 'Closed', 'Cancelled', 'Open', 'urgent Open', '100%', 'under_score', 'null', '', '   ', null];

let dir: string;
let db: DatabaseSyncType;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-filtersql-'));
  db = new DatabaseSync(join(dir, 'f.db'));
  db.exec(`CREATE TABLE t (v TEXT)`);
  const ins = db.prepare(`INSERT INTO t (v) VALUES (?)`);
  for (const v of VALUES) ins.run(v);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Values SQL returns for a filter. */
function viaSql(filter: string, defaultSubstring = true): Array<string | null> {
  const frag = columnFilterToSql('"v"', filter, { defaultSubstring });
  expect(frag.expressible).toBe(true);
  const where = frag.sql ? `WHERE ${frag.sql}` : '';
  const rows = db.prepare(`SELECT v FROM t ${where}`).all(...(frag.params as never[])) as Array<{ v: string | null }>;
  return rows.map((r) => r.v);
}

/** Values the in-memory matcher returns for the same filter. */
function viaMatcher(filter: string, defaultSubstring = true): Array<string | null> {
  return VALUES.filter((v) => matchesColumnFilter(v, filter, { defaultSubstring }));
}

const CASES = [
  'Sweden',
  'sweden',
  'SWEDEN',
  'Sweden,Norway',
  '!Closed',
  '!Closed,!Cancelled',
  'Open,!urgent',
  // The NEGATIVE first, which is the order a user types when they mean "not
  // this, but that". The clauses are emitted positives-first, so a filter of
  // this shape is the only one where the params can bind to the wrong `?` —
  // `!CC,Flat` asked SQL for "contains CC and not Flat", silently.
  '!Closed,Open',
  '!Sweden,Norway',
  '!NULL,Open',
  '!urgent,Open,Norway',
  '^S',
  '!^S',
  '=Open',
  '!=Open',
  'NULL',
  '!NULL',
  '!',
  '',
  'w',
  '100%',
  'under_score',
  '"Berlin, DE",Norway',
  '!NULL AND Open',
  '^S AND !Sweden',
  'a AND b,Norway',
  'Sweden OR Norway',
  'null',
  '=null',
  '^null',
  // Wildcards: the three shapes, negated, and against the values holding SQL's
  // own wildcards so the LIKE escaping stays honest.
  '*wede*',
  'Swe*',
  '*den',
  '!*den',
  '*den,Open',
  // A wildcard exclusion FIRST — the same param-order trap as above, on the
  // forms the wildcards added.
  '!*den,Open',
  '!Swe*,Norway',
  '*%*',
  '*_*',
  '*NULL*',
  '*,*',
];

describe('columnFilterToSql agrees with the in-memory matcher', () => {
  for (const filter of CASES) {
    it(`matches for ${JSON.stringify(filter)}`, () => {
      // Order-insensitive: SQL makes no promise about row order without ORDER BY.
      expect([...viaSql(filter)].sort()).toEqual([...viaMatcher(filter)].sort());
    });
  }

  // The setting changes what a BARE value means, in both places at once. If the
  // two ever disagree, a windowed table filters differently from a small one and
  // nothing in the UI would say why.
  for (const filter of ['Sweden', 'Sweden,Norway', 'sweden', '!Closed', 'Open,!urgent', '*wede*', 'Swe*', '=Open', 'NULL', '!NULL', '', 'w']) {
    it(`matches with defaultSubstring off for ${JSON.stringify(filter)}`, () => {
      expect([...viaSql(filter, false)].sort()).toEqual([...viaMatcher(filter, false)].sort());
    });
  }

  it('binds every term as a parameter rather than inlining it', () => {
    // A term with a quote must not be able to change the statement.
    const frag = columnFilterToSql('"v"', `O'Brien`);
    expect(frag.sql).not.toContain("O'Brien");
    expect(frag.params).toEqual(["%o'brien%"]);
  });

  it('treats SQL wildcards in a term as literal text', () => {
    // `100%` must find the value "100%", not "everything starting 100".
    expect(viaSql('100%')).toEqual(['100%']);
    expect(viaSql('under_score')).toEqual(['under_score']);
  });
});

describe('buildWhere', () => {
  const sqlOf = (f: string) => (f === 'v' ? '"v"' : null);

  it('is empty and expressible when there is nothing to narrow', () => {
    const frag = buildWhere({}, '', sqlOf, ['v']);
    expect(frag.sql).toBe('');
    expect(frag.expressible).toBe(true);
  });

  it('ANDs a column filter with a global search', () => {
    const frag = buildWhere({ v: '!NULL' }, 'sweden', sqlOf, ['v']);
    const rows = db.prepare(`SELECT v FROM t WHERE ${frag.sql}`).all(...(frag.params as never[])) as Array<{ v: string }>;
    expect(rows.map((r) => r.v).sort()).toEqual(['Sweden', 'sweden']);
  });

  it('reports a filter on a computed column as inexpressible instead of dropping it', () => {
    // `total` has no SQL form (it is produced by a script), so the rows returned
    // are a SUPERSET and the caller must filter again — the alternative is
    // returning rows the user excluded and looking correct.
    const frag = buildWhere({ total: '>5' }, '', sqlOf, ['v']);
    expect(frag.expressible).toBe(false);
    expect(frag.sql).toBe('');
  });

  it('reports a search with no searchable SQL column as inexpressible', () => {
    const frag = buildWhere({}, 'anything', sqlOf, ['computed']);
    expect(frag.expressible).toBe(false);
  });
});

/**
 * A search term across SEVERAL columns.
 *
 * `buildWhere` used to translate the term per column and OR the results, which
 * is the wrong quantifier for half the language: an exclusion has to hold of
 * EVERY column, or `!CC` asks "is some column not CC" and excludes nothing.
 * Only ever exercised against one column before, where the two readings agree.
 *
 * The expectations are written out rather than cross-checked against the
 * matcher, because "across the columns" is a rule the single-cell matcher does
 * not have — it is stated here.
 */
describe('buildWhere — a search across several columns', () => {
  const ROWS: Array<[string | null, string]> = [
    ['CC', 'Ann'],
    ['Holiday', 'Bob'],
    ['Flat', 'Cid'],
    // The excluded value in the OTHER column: the row still has CC in it.
    ['Flat', 'CC Dave'],
    // And hidden INSIDE a word — "Accommodation" contains "cc".
    ['Flat Accommodation', 'Eve'],
    [null, 'Zoe'],
  ];
  const sqlOf = (f: string) => (f === 'type' || f === 'who' ? `"${f}"` : null);

  beforeEach(() => {
    db.exec(`CREATE TABLE s (type TEXT, who TEXT)`);
    const ins = db.prepare(`INSERT INTO s (type, who) VALUES (?, ?)`);
    for (const [type, who] of ROWS) ins.run(type, who);
  });

  const search = (term: string): string[] => {
    const frag = buildWhere({}, term, sqlOf, ['type', 'who']);
    expect(frag.expressible).toBe(true);
    const where = frag.sql ? `WHERE ${frag.sql}` : '';
    const rows = db.prepare(`SELECT type, who FROM s ${where}`).all(...(frag.params as never[])) as Array<{ type: string | null; who: string }>;
    return rows.map((r) => `${r.type ?? '-'}|${r.who}`).sort();
  };

  it('excludes the negated value and keeps the listed one', () => {
    // The reported bug: this came back EMPTY, because the row SQL kept was the
    // one row the caller then filtered out again.
    expect(search('!CC,Flat')).toEqual(['Flat|Cid']);
  });

  it('applies a lone exclusion to every column, not just one', () => {
    // Ann's row is out on `type`, Dave's on `who`, Eve's on a substring — and a
    // row with no value at all is not excluded by a term it cannot contain.
    expect(search('!CC')).toEqual(['-|Zoe', 'Flat|Cid', 'Holiday|Bob']);
  });

  it('satisfies a positive term from any column', () => {
    expect(search('Cid')).toEqual(['Flat|Cid']);
    expect(search('Flat')).toEqual(['Flat Accommodation|Eve', 'Flat|CC Dave', 'Flat|Cid']);
  });

  it('reads a comma as OR', () => {
    expect(search('Holiday,Cid')).toEqual(['Flat|Cid', 'Holiday|Bob']);
  });

  it('keeps the veto rule, so Flat,!CC is the same as !CC,Flat', () => {
    expect(search('Flat,!CC')).toEqual(search('!CC,Flat'));
  });

  it('carries the anchors and the exact form across', () => {
    expect(search('^Hol')).toEqual(['Holiday|Bob']);
    expect(search('=Flat')).toEqual(['Flat|CC Dave', 'Flat|Cid']);
  });

  it('matches everything for an empty term', () => {
    expect(search('')).toHaveLength(ROWS.length);
  });

  // The stage-1 gate has to hold here too, or a windowed table answers a quoted
  // search differently from a small one filtered in memory.
  it('takes an ordinary phrase as plain text, not as a list', () => {
    expect(search('CC Dave')).toEqual(['Flat|CC Dave']);
  });

  it('searches the whole box in quotes verbatim, comma and all', () => {
    // Unquoted this would be a list — "Flat" OR " Cid" — and take three rows.
    expect(search('Flat,Cid')).toEqual(['Flat Accommodation|Eve', 'Flat|CC Dave', 'Flat|Cid']);
    expect(search('"Flat, Cid"')).toEqual([]);
    expect(search('"CC Dave"')).toEqual(['Flat|CC Dave']);
  });

  it('carries the wildcards across every column', () => {
    expect(search('*ccommodation')).toEqual(['Flat Accommodation|Eve']);
    expect(search('Ann*')).toEqual(['CC|Ann']);
    expect(search('*oli*')).toEqual(['Holiday|Bob']);
  });
});
