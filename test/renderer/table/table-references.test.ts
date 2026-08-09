import { describe, expect, it } from 'vitest';
import type { ProjectionSpec, Table, ViewInstance } from '@easydb/shared';
import {
  describeReferences,
  findTableReferences,
  renameProjectionOutputs,
  renameProjectionSourceFields,
  repointProjectionSpec,
  specOf,
} from '../../../packages/renderer/src/table/table-references.js';

const table = (id: string, name: string, spec?: ProjectionSpec): Table => ({
  id,
  workspaceId: 'ws',
  name,
  code: name.toLowerCase(),
  columns: [],
  view: 'table',
  updatedAt: 0,
  ...(spec ? { source: { type: 'projection', config: spec as unknown as Record<string, unknown> } } : {}),
});

const spec = (...names: string[]): ProjectionSpec => ({
  version: 1,
  sources: names.map((tableName, i) => ({ alias: `s${i}`, tableName })),
  columns: [],
});

const view = (id: string, tableName: string, name = id): ViewInstance => ({ id, workspaceId: 'ws', tableId: 't?', tableName, templateId: 'tpl', name }) as ViewInstance;

describe('specOf', () => {
  it('returns the spec of a projection and null for anything else', () => {
    expect(specOf(table('a', 'A', spec('People')))?.sources[0]?.tableName).toBe('People');
    expect(specOf(table('b', 'B'))).toBeNull();
  });

  it('returns null for a projection whose config is malformed', () => {
    const broken = { ...table('c', 'C'), source: { type: 'projection', config: { version: 1 } } } as Table;
    expect(specOf(broken)).toBeNull();
  });
});

describe('findTableReferences', () => {
  const tables = [table('p', 'People'), table('x', 'Staff', spec('People', 'Dept')), table('y', 'Budgets', spec('Dept')), table('z', 'Both', spec('People'))];
  const views = [view('v1', 'People', 'Cards'), view('v2', 'Dept')];

  it('finds the projections and views that name a table', () => {
    const refs = findTableReferences('People', tables, views);
    expect(refs.projections.map((t) => t.name)).toEqual(['Staff', 'Both']);
    expect(refs.views.map((v) => v.id)).toEqual(['v1']);
  });

  it('finds nothing for a table nobody references', () => {
    const refs = findTableReferences('Orders', tables, views);
    expect(refs.projections).toEqual([]);
    expect(refs.views).toEqual([]);
  });

  it('matches the name exactly — not case-insensitively, because the binding is exact', () => {
    expect(findTableReferences('people', tables, views).projections).toEqual([]);
  });

  it('excludes the table being renamed from its own dependents', () => {
    // 'Both' is a projection over People; renaming 'Both' must not list itself.
    const selfRef = [table('s', 'Self', spec('Self'))];
    expect(findTableReferences('Self', selfRef, [], 's').projections).toEqual([]);
    expect(findTableReferences('Self', selfRef, []).projections.map((t) => t.id)).toEqual(['s']);
  });

  it('finds a projection that reads from another projection', () => {
    const chained = [table('x', 'Staff', spec('People')), table('y', 'StaffPlus', spec('Staff'))];
    expect(findTableReferences('Staff', chained, []).projections.map((t) => t.name)).toEqual(['StaffPlus']);
  });
});

describe('repointProjectionSpec', () => {
  it('renames every matching source and leaves the rest alone', () => {
    const next = repointProjectionSpec(spec('People', 'Dept', 'People'), 'People', 'Staff');
    expect(next?.sources.map((s) => s.tableName)).toEqual(['Staff', 'Dept', 'Staff']);
  });

  it('returns null when the spec does not name the table, so the caller can skip the write', () => {
    expect(repointProjectionSpec(spec('Dept'), 'People', 'Staff')).toBeNull();
  });

  it('does not mutate the original spec', () => {
    const original = spec('People');
    repointProjectionSpec(original, 'People', 'Staff');
    expect(original.sources[0]!.tableName).toBe('People');
  });

  it('keeps join keys, filters and the row cap intact', () => {
    const rich: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'p', tableName: 'People' },
        { alias: 'd', tableName: 'Dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
      ],
      columns: [{ field: 'n', from: { kind: 'source', alias: 'p', field: 'name' } }],
      filters: { n: 'a' },
      limit: 10,
    };
    const next = repointProjectionSpec(rich, 'People', 'Staff')!;
    expect(next.sources[1]!.join).toEqual(rich.sources[1]!.join);
    expect(next.filters).toEqual({ n: 'a' });
    expect(next.limit).toBe(10);
    expect(next.columns).toEqual(rich.columns);
  });
});

describe('describeReferences', () => {
  it('names the dependents rather than only counting them', () => {
    const text = describeReferences({ projections: [table('x', 'Staff')], views: [view('v1', 'People', 'Cards')] });
    expect(text).toBe('1 projection ("Staff") and 1 view ("Cards")');
  });

  it('pluralises, and truncates a long list', () => {
    const many = ['A', 'B', 'C', 'D', 'E'].map((n, i) => table(String(i), n));
    expect(describeReferences({ projections: many, views: [] })).toBe('5 projections ("A", "B", "C" and 2 more)');
  });

  it('is null when nothing references the table, so the caller shows no dialog', () => {
    expect(describeReferences({ projections: [], views: [] })).toBeNull();
  });

  it('mentions only the kind that actually has dependents', () => {
    expect(describeReferences({ projections: [], views: [view('v1', 'People', 'Cards')] })).toBe('1 view ("Cards")');
  });
});

/**
 * A projection names FIELDS in three places, and the columns editor renaming a
 * field used to rewrite none of them: the projection kept writing the old key
 * into every row while the renamed column read the new one, so the column came
 * out empty. A join key left on the old name matched nothing at all.
 */
describe('renameProjectionOutputs', () => {
  const outputs = (): ProjectionSpec => ({
    version: 1,
    sources: [{ alias: 'p', tableName: 'People' }],
    columns: [
      { field: 'name', from: { kind: 'source', alias: 'p', field: 'full_name' } },
      { field: 'age', from: { kind: 'source', alias: 'p', field: 'age' } },
    ],
    filters: { name: 'a', age: '>1' },
  });

  it('renames the output field, leaving the source field it reads alone', () => {
    const next = renameProjectionOutputs(outputs(), [{ from: 'name', to: 'label' }])!;
    expect(next.columns[0]!.field).toBe('label');
    expect(next.columns[0]!.from).toEqual({ kind: 'source', alias: 'p', field: 'full_name' });
    expect(next.columns[1]!.field).toBe('age');
  });

  it('moves the filter keyed by that output field with it', () => {
    const next = renameProjectionOutputs(outputs(), [{ from: 'name', to: 'label' }])!;
    expect(next.filters).toEqual({ label: 'a', age: '>1' });
  });

  it('applies a SWAP in one pass rather than one rename over the other', () => {
    const next = renameProjectionOutputs(outputs(), [
      { from: 'name', to: 'age' },
      { from: 'age', to: 'name' },
    ])!;
    expect(next.columns.map((c) => c.field)).toEqual(['age', 'name']);
  });

  it('is null when no output field is touched, so the caller skips the write', () => {
    expect(renameProjectionOutputs(outputs(), [{ from: 'nothing', to: 'x' }])).toBeNull();
    expect(renameProjectionOutputs(outputs(), [])).toBeNull();
    expect(renameProjectionOutputs(outputs(), [{ from: 'name', to: 'name' }])).toBeNull();
  });
});

describe('renameProjectionSourceFields', () => {
  const joined = (): ProjectionSpec => ({
    version: 1,
    sources: [
      { alias: 'o', tableName: 'Orders' },
      { alias: 'p', tableName: 'People', join: { type: 'inner', on: [{ field: 'person_id', eqAlias: 'o', eqField: 'buyer_id' }] } },
    ],
    columns: [
      { field: 'buyer', from: { kind: 'source', alias: 'p', field: 'full_name' } },
      { field: 'total', from: { kind: 'source', alias: 'o', field: 'total' } },
      { field: 'calc', from: { kind: 'script', script: 'return 1' } },
    ],
  });

  it('renames the source field a column reads', () => {
    const next = renameProjectionSourceFields(joined(), 'People', [{ from: 'full_name', to: 'name' }])!;
    expect(next.columns[0]!.from).toEqual({ kind: 'source', alias: 'p', field: 'name' });
    // The OUTPUT field is unaffected — the projection's own column keeps its name.
    expect(next.columns[0]!.field).toBe('buyer');
  });

  it('renames the join key on the side of the renamed table', () => {
    const next = renameProjectionSourceFields(joined(), 'People', [{ from: 'person_id', to: 'pid' }])!;
    expect(next.sources[1]!.join!.on[0]).toEqual({ field: 'pid', eqAlias: 'o', eqField: 'buyer_id' });
  });

  it('renames the OTHER side of the join when that is the renamed table', () => {
    const next = renameProjectionSourceFields(joined(), 'Orders', [{ from: 'buyer_id', to: 'bid' }])!;
    expect(next.sources[1]!.join!.on[0]).toEqual({ field: 'person_id', eqAlias: 'o', eqField: 'bid' });
  });

  it('covers every alias of a self-join, not just the first', () => {
    const selfJoin: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'a', tableName: 'People' },
        { alias: 'b', tableName: 'People', join: { type: 'left', on: [{ field: 'boss_id', eqAlias: 'a', eqField: 'boss_id' }] } },
      ],
      columns: [
        { field: 'me', from: { kind: 'source', alias: 'a', field: 'boss_id' } },
        { field: 'them', from: { kind: 'source', alias: 'b', field: 'boss_id' } },
      ],
    };
    const next = renameProjectionSourceFields(selfJoin, 'People', [{ from: 'boss_id', to: 'manager_id' }])!;
    expect(next.columns.map((c) => (c.from.kind === 'source' ? c.from.field : ''))).toEqual(['manager_id', 'manager_id']);
    expect(next.sources[1]!.join!.on[0]).toEqual({ field: 'manager_id', eqAlias: 'a', eqField: 'manager_id' });
  });

  it('leaves a scripted column and an unrelated table alone', () => {
    const next = renameProjectionSourceFields(joined(), 'People', [{ from: 'full_name', to: 'name' }])!;
    expect(next.columns[2]!.from).toEqual({ kind: 'script', script: 'return 1' });
    expect(renameProjectionSourceFields(joined(), 'Elsewhere', [{ from: 'full_name', to: 'name' }])).toBeNull();
  });

  it('is null when the spec names none of the renamed fields', () => {
    expect(renameProjectionSourceFields(joined(), 'People', [{ from: 'unused', to: 'x' }])).toBeNull();
  });
});
