import { describe, expect, it } from 'vitest';
import type { ProjectionSpec, Table, ViewInstance } from '@easydb/shared';
import { describeReferences, findTableReferences, repointProjectionSpec, specOf } from '../../../packages/renderer/src/table/table-references.js';

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
