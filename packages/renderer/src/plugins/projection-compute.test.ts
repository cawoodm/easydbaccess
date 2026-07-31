import { describe, expect, it } from 'vitest';
import type { ProjectionSpec, Row, Table } from '@easydb/shared';
import {
  computeProjection,
  guessJoinKeys,
  hasProjectionCycle,
  resolveWritability,
  writebackTarget,
} from './projection-compute.js';

const row = (id: string, data: Record<string, unknown>, updatedAt = 1): Row => ({
  id,
  tableId: 't',
  data,
  updatedAt,
});

describe('computeProjection', () => {
  it('selects and renames columns from a single source, stamping #0 ids', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [{ alias: 'a', tableName: 'People' }],
      columns: [{ field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'a', field: 'fullname' } }],
    };
    const out = computeProjection(spec, { a: [row('r1', { fullname: 'Bob' }), row('r2', { fullname: 'Sue' })] });
    expect(out).toEqual([
      { id: 'r1#0', tableId: '', data: { name: 'Bob' }, updatedAt: 1 },
      { id: 'r2#0', tableId: '', data: { name: 'Sue' }, updatedAt: 1 },
    ]);
  });

  it('inner join drops base rows with no match', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'o', tableName: 'Orders' },
        { alias: 'c', tableName: 'Cust', join: { type: 'inner', on: [{ field: 'id', eqAlias: 'o', eqField: 'custId' }] } },
      ],
      columns: [
        { field: 'order', label: 'Order', type: 'string', from: { kind: 'source', alias: 'o', field: 'ref' } },
        { field: 'customer', label: 'Customer', type: 'string', from: { kind: 'source', alias: 'c', field: 'name' } },
      ],
    };
    const out = computeProjection(spec, {
      o: [row('r1', { ref: 'A', custId: 'c1' }), row('r2', { ref: 'B', custId: 'c9' })],
      c: [row('c1', { id: 'c1', name: 'Bob' })],
    });
    expect(out.map((r) => r.data)).toEqual([{ order: 'A', customer: 'Bob' }]);
    expect(out[0]?.id).toBe('r1#0');
  });

  it('left join fans out to one row per match and keeps unmatched base rows', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'c', tableName: 'Cust' },
        { alias: 'o', tableName: 'Ord', join: { type: 'left', on: [{ field: 'custId', eqAlias: 'c', eqField: 'id' }] } },
      ],
      columns: [
        { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'c', field: 'name' } },
        { field: 'amt', label: 'Amount', type: 'number', from: { kind: 'source', alias: 'o', field: 'amt' } },
      ],
    };
    const out = computeProjection(spec, {
      c: [row('c1', { id: 'c1', name: 'Bob' }), row('c2', { id: 'c2', name: 'Sue' })],
      o: [row('o1', { custId: 'c1', amt: 10 }), row('o2', { custId: 'c1', amt: 20 })],
    });
    expect(out).toEqual([
      { id: 'c1#0', tableId: '', data: { name: 'Bob', amt: 10 }, updatedAt: 1 },
      { id: 'c1#1', tableId: '', data: { name: 'Bob', amt: 20 }, updatedAt: 1 },
      { id: 'c2#0', tableId: '', data: { name: 'Sue', amt: undefined }, updatedAt: 1 },
    ]);
  });

  it('applies filters (substring, keyed by output field) to the joined rows', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [{ alias: 'a', tableName: 'People' }],
      columns: [{ field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'a', field: 'name' } }],
      filters: { name: 'Bo' },
    };
    const out = computeProjection(spec, { a: [row('r1', { name: 'Bob' }), row('r2', { name: 'Sue' })] });
    expect(out.map((r) => r.data.name)).toEqual(['Bob']);
  });

  it('evaluates a computed (script) column against the already-selected source columns', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [{ alias: 'a', tableName: 'People' }],
      columns: [
        { field: 'first', label: 'First', type: 'string', from: { kind: 'source', alias: 'a', field: 'first' } },
        { field: 'last', label: 'Last', type: 'string', from: { kind: 'source', alias: 'a', field: 'last' } },
        { field: 'full', label: 'Full', type: 'string', from: { kind: 'script', script: 'function render(row){ return row.first + " " + row.last; }' } },
      ],
    };
    const out = computeProjection(spec, { a: [row('r1', { first: 'Bob', last: 'Smith' })] });
    expect(out[0]?.data.full).toBe('Bob Smith');
  });

  it('returns nothing when the base source has no rows', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [{ alias: 'a', tableName: 'People' }],
      columns: [{ field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'a', field: 'name' } }],
    };
    expect(computeProjection(spec, {})).toEqual([]);
  });
});

describe('hasProjectionCycle', () => {
  const plain = (id: string, name: string): Table => ({
    id,
    workspaceId: 'ws',
    name,
    code: name,
    columns: [],
    view: 'table',
    updatedAt: 0,
  });
  const proj = (id: string, name: string, sourceNames: string[]): Table => ({
    ...plain(id, name),
    source: {
      type: 'projection',
      config: {
        version: 1,
        sources: sourceNames.map((n, i) => ({ alias: `s${i}`, tableName: n })),
        columns: [],
      } as unknown as Record<string, unknown>,
    },
  });

  it('is false for a projection over plain tables', () => {
    const tables = [plain('t1', 'People'), proj('p1', 'View', ['People'])];
    expect(hasProjectionCycle('p1', tables)).toBe(false);
  });

  it('is false for a legitimate projection-on-projection chain', () => {
    const tables = [plain('t1', 'People'), proj('p1', 'A', ['People']), proj('p2', 'B', ['A'])];
    expect(hasProjectionCycle('p2', tables)).toBe(false);
  });

  it('detects a projection that sources itself', () => {
    expect(hasProjectionCycle('p1', [proj('p1', 'Self', ['Self'])])).toBe(true);
  });

  it('detects a transitive cycle', () => {
    const tables = [proj('p1', 'A', ['B']), proj('p2', 'B', ['C']), proj('p3', 'C', ['A'])];
    expect(hasProjectionCycle('p1', tables)).toBe(true);
  });

  it('does not depend on how many projections are read at once', () => {
    // Nine independent projections: none is a cycle, however many exist.
    const tables: Table[] = [plain('t1', 'People')];
    for (let i = 0; i < 9; i++) tables.push(proj(`p${i}`, `V${i}`, ['People']));
    for (let i = 0; i < 9; i++) expect(hasProjectionCycle(`p${i}`, tables)).toBe(false);
  });
});

describe('guessJoinKeys', () => {
  it('matches the FK convention: new table id = earlier <table>Id', () => {
    expect(
      guessJoinKeys({ tableName: 'Dept', fields: ['id', 'label', 'budget'] }, [
        { alias: 'p', tableName: 'People', fields: ['name', 'deptId'] },
      ]),
    ).toEqual({ thisField: 'id', otherAlias: 'p', otherField: 'deptId' });
  });

  it('matches a shared foreign-key-shaped column on both sides', () => {
    expect(
      guessJoinKeys({ tableName: 'Orders', fields: ['id', 'customerId', 'total'] }, [
        { alias: 'c', tableName: 'Customers', fields: ['customerId', 'name'] },
      ]),
    ).toEqual({ thisField: 'customerId', otherAlias: 'c', otherField: 'customerId' });
  });

  it('does not guess on a bare id = id, nor when nothing matches', () => {
    expect(
      guessJoinKeys({ tableName: 'A', fields: ['id', 'x'] }, [
        { alias: 'b', tableName: 'B', fields: ['id', 'y'] },
      ]),
    ).toBeNull();
    expect(
      guessJoinKeys({ tableName: 'A', fields: ['foo'] }, [
        { alias: 'b', tableName: 'B', fields: ['bar'] },
      ]),
    ).toBeNull();
  });
});

describe('writeback', () => {
  const spec: ProjectionSpec = {
    version: 1,
    sources: [
      { alias: 'a', tableName: 'People' },
      { alias: 'b', tableName: 'Dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'a', eqField: 'deptId' }] } },
    ],
    columns: [
      { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'a', field: 'fullname' } },
      { field: 'dept', label: 'Dept', type: 'string', from: { kind: 'source', alias: 'b', field: 'name' } },
      { field: 'calc', label: 'Calc', type: 'string', from: { kind: 'script', script: 'function render(r){return 1;}' } },
    ],
  };

  it('resolveWritability lists only base-source, non-script output fields', () => {
    expect(resolveWritability(spec)).toEqual(new Set(['name']));
  });

  it('writebackTarget maps a base-source cell to its base row + stored field', () => {
    expect(writebackTarget(spec, 'r1#2', 'name')).toEqual({ baseRowId: 'r1', field: 'fullname' });
  });

  it('writebackTarget refuses secondary-source and computed columns', () => {
    expect(writebackTarget(spec, 'r1#0', 'dept')).toBeNull();
    expect(writebackTarget(spec, 'r1#0', 'calc')).toBeNull();
  });
});
