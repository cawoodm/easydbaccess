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
const VALUES: Array<string | null> = [
  'Sweden',
  'sweden',
  'Norway',
  'Switzerland',
  'Berlin, DE',
  'Closed',
  'Cancelled',
  'Open',
  'urgent Open',
  '100%',
  'under_score',
  'null',
  '',
  '   ',
  null,
];

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
function viaSql(filter: string): Array<string | null> {
  const frag = columnFilterToSql('"v"', filter);
  expect(frag.expressible).toBe(true);
  const where = frag.sql ? `WHERE ${frag.sql}` : '';
  const rows = db.prepare(`SELECT v FROM t ${where}`).all(...(frag.params as never[])) as Array<{ v: string | null }>;
  return rows.map((r) => r.v);
}

/** Values the in-memory matcher returns for the same filter. */
function viaMatcher(filter: string): Array<string | null> {
  return VALUES.filter((v) => matchesColumnFilter(v, filter));
}

const CASES = [
  'Sweden',
  'sweden',
  'SWEDEN',
  'Sweden,Norway',
  '!Closed',
  '!Closed,!Cancelled',
  'Open,!urgent',
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
];

describe('columnFilterToSql agrees with the in-memory matcher', () => {
  for (const filter of CASES) {
    it(`matches for ${JSON.stringify(filter)}`, () => {
      // Order-insensitive: SQL makes no promise about row order without ORDER BY.
      expect([...viaSql(filter)].sort()).toEqual([...viaMatcher(filter)].sort());
    });
  }

  it('binds every term as a parameter rather than inlining it', () => {
    // A term with a quote must not be able to change the statement.
    const frag = columnFilterToSql('"v"', `O'Brien`);
    expect(frag.sql).not.toContain("O'Brien");
    expect(frag.params).toEqual(["%o'brien%"]);
  });

  it("treats SQL wildcards in a term as literal text", () => {
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
