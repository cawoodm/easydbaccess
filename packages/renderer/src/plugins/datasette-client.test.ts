import { describe, expect, it, vi } from 'vitest';
import {
  parseDatabaseList,
  parseTableList,
  discoverTables,
  parseDatasetteUrl,
} from './datasette-client.js';

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
});

describe('parseTableList', () => {
  it('reads { tables: [{ name, count, hidden }] } and carries the db through', () => {
    const json = {
      database: 'fixtures',
      tables: [
        { name: 'facetable', count: 15, hidden: false },
        { name: 'searchable_fts', count: 3, hidden: true },
        { name: 'no_count' },
      ],
    };
    expect(parseTableList(json, 'fixtures')).toEqual([
      { db: 'fixtures', table: 'facetable', count: 15, hidden: false },
      { db: 'fixtures', table: 'searchable_fts', count: 3, hidden: true },
      { db: 'fixtures', table: 'no_count', count: null, hidden: false },
    ]);
  });

  it('tolerates a bare array and string entries', () => {
    expect(parseTableList(['t1', 't2'], 'db')).toEqual([
      { db: 'db', table: 't1', count: null, hidden: false },
      { db: 'db', table: 't2', count: null, hidden: false },
    ]);
  });
});

describe('discoverTables', () => {
  const jsonRes = (body: unknown): Promise<Response> =>
    Promise.resolve({ json: () => Promise.resolve(body) } as unknown as Response);

  it('returns just the table for a table URL (no network)', async () => {
    const fetchFn = vi.fn();
    const ref = parseDatasetteUrl('https://x.datasette.io/fixtures/facetable');
    const out = await discoverTables(fetchFn, ref);
    expect(out).toEqual([{ db: 'fixtures', table: 'facetable', count: null, hidden: false }]);
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
    expect(out).toEqual([{ db: 'fixtures', table: 'facetable', count: 15, hidden: false }]);
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
      { db: 'a', table: 't1', count: 2, hidden: false },
      { db: 'b', table: 't2', count: 5, hidden: false },
    ]);
  });
});
