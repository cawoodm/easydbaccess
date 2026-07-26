import { describe, expect, it } from 'vitest';
import { parsedToTables } from './json-import.js';

// Characterization tests for `parsedToTables`, the JSON dump shape detector.
// It is the only shape-detection entry point exported from json-import.ts —
// `inferTypeFromValues`, `isDateString`, `looksLikeV1Dump`, `convertV1Dump`,
// and `inferTableFromRows` are all module-private, so type inference below is
// exercised indirectly through the columns `parsedToTables` produces.

describe('parsedToTables: v1 / legacy minniDBMax dump shape', () => {
  it('converts a "<Name>.table.json" wrapper into a NormalizedTable', () => {
    const dump = {
      'People.table.json': {
        dataArray: [
          ['Alice', 30],
          ['Bob', 25],
        ],
        columns: [
          { field: 'name', name: 'Name', type: 'string' },
          { field: 'age', name: 'Age', type: 'number' },
        ],
      },
    };

    const tables = parsedToTables(dump, 'fallback');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('People');
    expect(tables[0]?.columns).toEqual([
      { field: 'name', label: 'Name', type: 'string' },
      { field: 'age', label: 'Age', type: 'number' },
    ]);
    expect(tables[0]?.rows).toEqual([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
  });

  it('carries geometry only when both x and y are present', () => {
    const withRect = {
      'T.table.json': {
        dataArray: [['a']],
        columns: [{ field: 'f' }],
        elementRect: { x: 10, y: 20, width: 300, height: 200, zIndex: 5 },
      },
    };
    const [t] = parsedToTables(withRect, 'fallback');
    expect(t?.windowGeometry).toEqual({
      x: 10,
      y: 20,
      w: 300,
      h: 200,
      z: 5,
      minimized: false,
      maximized: false,
    });

    const withoutXY = {
      'T.table.json': {
        dataArray: [['a']],
        columns: [{ field: 'f' }],
        elementRect: { width: 300, height: 200 },
      },
    };
    const [t2] = parsedToTables(withoutXY, 'fallback');
    expect(t2?.windowGeometry).toBeUndefined();
  });

  it('carries unique/notnull column flags and sortColumn/sortDirection', () => {
    const dump = {
      'T.table.json': {
        dataArray: [['x']],
        columns: [{ field: 'f', name: 'F', isUnique: true, isNotNull: true }],
        sortColumn: 0,
        sortDirection: 'desc',
      },
    };
    const [t] = parsedToTables(dump, 'fallback');
    expect(t?.columns[0]).toMatchObject({ unique: true, notnull: true });
    expect(t?.sortColumn).toBe('f');
    expect(t?.sortAsc).toBe(false);
  });

  it('converts pre-v3 color/image column types into renderer annotations', () => {
    // v1 dumps predate the `renderer` field — color/image were column *types*.
    const dump = {
      'T.table.json': {
        dataArray: [['#fff']],
        columns: [{ field: 'c', name: 'Color', type: 'color' }],
      },
    };
    // This path goes through convertV1Dump -> normalizeV1Column, which does
    // NOT rewrite color/image (that rewrite only exists in normalizeColumn,
    // used by the native-dump path below). Document that asymmetry: the v1
    // column keeps its literal (non-ColumnType) `type` string verbatim.
    const [t] = parsedToTables(dump, 'fallback');
    expect(t?.columns[0]?.type).toBe('color');
  });
});

describe('parsedToTables: native dump shape ({ tables: [...] })', () => {
  it('reads name/columns/rows straight through, normalizing columns', () => {
    const dump = {
      tables: [
        {
          name: 'Widgets',
          columns: [{ field: 'sku', label: 'SKU', type: 'string' }],
          rows: [{ sku: 'A1' }, { sku: 'A2' }],
        },
      ],
    };
    const tables = parsedToTables(dump, 'fallback');
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      name: 'Widgets',
      columns: [{ field: 'sku', label: 'SKU', type: 'string' }],
      rows: [{ sku: 'A1' }, { sku: 'A2' }],
    });
  });

  it('rewrites pre-v3 color/image column types to string + renderer', () => {
    const dump = {
      tables: [
        {
          name: 'T',
          columns: [{ field: 'c', label: 'Color', type: 'color' }],
          rows: [{ c: '#fff' }],
        },
      ],
    };
    const [t] = parsedToTables(dump, 'fallback');
    expect(t?.columns[0]).toEqual({ field: 'c', label: 'Color', type: 'string', renderer: 'color' });
  });

  it('carries a live `source` descriptor and a snapshot `origin` when present', () => {
    const dump = {
      tables: [
        {
          name: 'Live',
          columns: [{ field: 'a' }],
          rows: [],
          source: { type: 'datasette', config: { base: 'x' } },
        },
        {
          name: 'Snap',
          columns: [{ field: 'a' }],
          rows: [],
          origin: { type: 'datasette', url: 'https://example.com/db/table' },
        },
      ],
    };
    const [live, snap] = parsedToTables(dump, 'fallback');
    expect(live?.source).toEqual({ type: 'datasette', config: { base: 'x' } });
    expect(live?.origin).toBeUndefined();
    expect(snap?.origin).toEqual({ type: 'datasette', url: 'https://example.com/db/table' });
    expect(snap?.source).toBeUndefined();
  });

  it('falls back to v1 conversion for a v1-shaped entry inside `tables`', () => {
    // Happens when a v1 file was Dumped through the app before v1 detection
    // landed: entries look like `{ "<name>.table.json": { dataArray, columns } }`.
    const dump = {
      tables: [
        {
          'Legacy.table.json': {
            dataArray: [['v']],
            columns: [{ field: 'f' }],
          },
        },
      ],
    };
    const tables = parsedToTables(dump, 'fallback');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe('Legacy');
    expect(tables[0]?.rows).toEqual([{ f: 'v' }]);
  });

  it('drops non-native, non-v1-shaped entries from `tables`', () => {
    const dump = { tables: [{ nonsense: true }] };
    expect(parsedToTables(dump, 'fallback')).toEqual([]);
  });

  it('carries per-table window/display state (title, geometry, filters, labelColumn, info, deletedColumns)', () => {
    const geom = { x: 10, y: 20, w: 300, h: 200, z: 5, minimized: false, maximized: false };
    const dump = {
      tables: [
        {
          name: 'Rich',
          columns: [{ field: 'a' }],
          rows: [],
          title: 'Rich Display',
          windowGeometry: geom,
          sortColumn: 'a',
          sortAsc: false,
          filters: { a: 'x' },
          labelColumn: 'a',
          info: { description: 'about' },
          deletedColumns: ['gone'],
        },
      ],
    };
    const [t] = parsedToTables(dump, 'fallback');
    expect(t?.title).toBe('Rich Display');
    expect(t?.windowGeometry).toEqual(geom);
    expect(t?.sortColumn).toBe('a');
    expect(t?.sortAsc).toBe(false);
    expect(t?.filters).toEqual({ a: 'x' });
    expect(t?.labelColumn).toBe('a');
    expect(t?.info).toEqual({ description: 'about' });
    expect(t?.deletedColumns).toEqual(['gone']);
  });
});

describe('parsedToTables: bare array-of-objects', () => {
  it('infers columns from the union of keys across all rows, in first-seen order', () => {
    const rows = [
      { name: 'Alice', age: 30 },
      { name: 'Bob', city: 'Bern' },
    ];
    const [t] = parsedToTables(rows, 'people');
    expect(t?.name).toBe('people');
    expect(t?.columns.map((c) => c.field)).toEqual(['name', 'age', 'city']);
    // Missing keys are simply absent from that row's object (no forced nulls).
    expect(t?.rows).toEqual(rows);
  });

  it('returns no tables for an empty array or an array with no plain objects', () => {
    expect(parsedToTables([], 'fallback')).toEqual([]);
    expect(parsedToTables([1, 'a', null, [1, 2]], 'fallback')).toEqual([]);
  });

  it('filters out non-object entries but keeps the plain-object ones', () => {
    const rows = [{ a: 1 }, 'skip-me', { a: 2 }];
    const [t] = parsedToTables(rows, 'fallback');
    expect(t?.rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('parsedToTables: single bare object -> one-row table', () => {
  it('wraps a plain object (that is not a recognized dump shape) as a single row', () => {
    const obj = { id: 1, label: 'solo' };
    const [t] = parsedToTables(obj, 'single');
    expect(t?.name).toBe('single');
    expect(t?.rows).toEqual([obj]);
    expect(t?.columns.map((c) => c.field)).toEqual(['id', 'label']);
  });

  it('returns [] for a scalar, null, or non-object/non-array input', () => {
    expect(parsedToTables(42, 'fallback')).toEqual([]);
    expect(parsedToTables('a string', 'fallback')).toEqual([]);
    expect(parsedToTables(null, 'fallback')).toEqual([]);
    expect(parsedToTables(true, 'fallback')).toEqual([]);
  });
});

describe('parsedToTables: nested / heterogeneous objects (inferTypeFromValues via inferTableFromRows)', () => {
  it('keeps a nested object/array value as-is (typed "string" since it is neither number/boolean/date)', () => {
    const rows = [
      { id: 1, meta: { nested: true } },
      { id: 2, meta: { nested: false } },
    ];
    const [t] = parsedToTables(rows, 'fallback');
    const metaCol = t?.columns.find((c) => c.field === 'meta');
    expect(metaCol?.type).toBe('string');
    expect(t?.rows[0]?.meta).toEqual({ nested: true });
  });

  it('falls back to "string" for a column with heterogeneous value types', () => {
    const rows = [{ v: 1 }, { v: 'two' }, { v: true }];
    const [t] = parsedToTables(rows, 'fallback');
    expect(t?.columns.find((c) => c.field === 'v')?.type).toBe('string');
  });

  it('infers "number" only when every non-empty sample is a finite number', () => {
    const rows = [{ n: 1 }, { n: 2.5 }, { n: null }, { n: undefined }];
    const [t] = parsedToTables(rows, 'fallback');
    expect(t?.columns.find((c) => c.field === 'n')?.type).toBe('number');
  });

  it('infers "boolean" only when every non-empty sample is a boolean', () => {
    const rows = [{ b: true }, { b: false }, { b: '' }];
    const [t] = parsedToTables(rows, 'fallback');
    expect(t?.columns.find((c) => c.field === 'b')?.type).toBe('boolean');
  });

  it('infers "date" when every non-empty sample string parses as a Date, but not for numeric-looking strings', () => {
    const dateRows = [{ d: '2024-01-01' }, { d: '2024-06-15' }];
    const [t1] = parsedToTables(dateRows, 'fallback');
    expect(t1?.columns.find((c) => c.field === 'd')?.type).toBe('date');

    // Bare-integer strings are explicitly excluded by isDateString, so a
    // column of numeric-looking id strings must NOT be classified as a date.
    const idRows = [{ d: '12345' }, { d: '67890' }];
    const [t2] = parsedToTables(idRows, 'fallback');
    expect(t2?.columns.find((c) => c.field === 'd')?.type).toBe('string');
  });

  it('defaults an all-empty/null/undefined column to "string"', () => {
    const rows = [{ v: null }, { v: undefined }, { v: '' }];
    const [t] = parsedToTables(rows, 'fallback');
    expect(t?.columns.find((c) => c.field === 'v')?.type).toBe('string');
  });
});
