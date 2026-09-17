import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Table } from '../../../packages/shared/src/types.js';
import {
  conditionalPatch,
  constraintErrorMessage,
  draftProblem,
  migrateRowData,
  planColumnChanges,
  saveStageError,
  tightenedConstraints,
} from '../../../packages/renderer/src/table/table-save.js';

function col(field: string, extra: Partial<ColumnSpec> = {}): ColumnSpec {
  return { field, label: field, type: 'string', ...extra };
}

function table(over: Partial<Table> = {}): Table {
  return {
    id: 't1',
    workspaceId: 'w1',
    name: 'People',
    code: 'people',
    columns: [col('name'), col('note')],
    view: 'table',
    updatedAt: 0,
    ...over,
  } as Table;
}

describe('draftProblem', () => {
  const base = { tables: [] as Table[], selfId: null };

  it('passes a clean draft', () => {
    expect(draftProblem({ ...base, name: 'People', fields: ['name'] })).toBeNull();
  });

  it('rejects an empty name', () => {
    expect(draftProblem({ ...base, name: '', fields: ['name'] })).toMatch(/name is required/);
  });

  it('rejects a name another table already has, whatever its case', () => {
    const tables = [table({ id: 'other', name: 'People' })];
    expect(draftProblem({ tables, selfId: null, name: 'people', fields: ['name'] })).toMatch(/already exists/);
  });

  it('does not clash a table with itself', () => {
    const tables = [table({ id: 't1', name: 'People' })];
    expect(draftProblem({ tables, selfId: 't1', name: 'People', fields: ['name'] })).toBeNull();
  });

  it('needs at least one column', () => {
    expect(draftProblem({ ...base, name: 'People', fields: [] })).toMatch(/At least one column/);
  });

  it('rejects a blank field name', () => {
    expect(draftProblem({ ...base, name: 'People', fields: ['name', '  '] })).toMatch(/cannot be empty/);
  });

  it('rejects two fields that differ only in case, naming both spellings', () => {
    const msg = draftProblem({ ...base, name: 'People', fields: ['name', 'Name'] });
    expect(msg).toContain('"Name"');
    expect(msg).toContain('"name"');
    expect(msg).toMatch(/not case-sensitive/);
  });

  it('names the field once when the two spellings are identical', () => {
    expect(draftProblem({ ...base, name: 'People', fields: ['name', 'name'] })).toBe('Duplicate column field: name');
  });
});

describe('planColumnChanges', () => {
  it('records a removed column and purges its data', () => {
    const existing = table({ columns: [col('name'), col('note')] });
    const plan = planColumnChanges(existing, [col('name')], new Set(['name']));
    expect(plan.removedNow).toEqual(['note']);
    expect(plan.deletedColumns).toEqual(['note']);
    expect(plan.purgeFields).toEqual(['note']);
  });

  it('treats a rename as kept, not removed', () => {
    const existing = table({ columns: [col('name'), col('note')] });
    // `note` was renamed to `comment`, so its origField is still kept.
    const plan = planColumnChanges(existing, [col('name'), col('comment')], new Set(['name', 'note']));
    expect(plan.removedNow).toEqual([]);
    expect(plan.deletedColumns).toEqual([]);
    expect(plan.purgeFields).toEqual([]);
  });

  it('drops a previously-deleted name once the column is back', () => {
    const existing = table({ columns: [col('name')], deletedColumns: ['note'] });
    const plan = planColumnChanges(existing, [col('name'), col('note')], new Set(['name']));
    expect(plan.deletedColumns).toEqual([]);
    expect(plan.prevDeleted).toEqual(['note']);
  });

  it('keeps earlier deletions alongside a new one', () => {
    const existing = table({ columns: [col('name'), col('note')], deletedColumns: ['old'] });
    const plan = planColumnChanges(existing, [col('name')], new Set(['name']));
    expect(plan.deletedColumns).toEqual(['old', 'note']);
  });

  it('handles a table that is not there yet', () => {
    const plan = planColumnChanges(null, [col('name')], new Set());
    expect(plan.removedNow).toEqual([]);
    expect(plan.deletedColumns).toEqual([]);
  });
});

describe('tightenedConstraints', () => {
  it('reports a newly-unique column', () => {
    const next = [col('name', { unique: true })];
    expect(tightenedConstraints(next, [col('name')]).map((c) => c.field)).toEqual(['name']);
  });

  it('ignores a constraint that was already on', () => {
    const was = [col('name', { unique: true, notnull: true })];
    expect(tightenedConstraints(was, was)).toEqual([]);
  });

  it('reports a changed max but not a max of zero', () => {
    expect(tightenedConstraints([col('name', { max: 10 })], [col('name')]).length).toBe(1);
    expect(tightenedConstraints([col('name', { max: 0 })], [col('name')]).length).toBe(0);
  });

  it('reports a constraint on a brand-new column', () => {
    expect(tightenedConstraints([col('age', { notnull: true })], []).length).toBe(1);
  });
});

describe('constraintErrorMessage', () => {
  it('reads as singular for one row', () => {
    expect(constraintErrorMessage(['Row 1: x'])).toContain('1 existing row violates');
  });

  it('lists five and counts the rest', () => {
    const msg = constraintErrorMessage(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(msg).toContain('7 existing rows violate');
    expect(msg).toContain('\ne');
    expect(msg).not.toContain('\nf');
    expect(msg).toContain('…and 2 more.');
  });
});

describe('migrateRowData', () => {
  it('returns null when nothing applies', () => {
    expect(migrateRowData({ a: 1 }, [], [])).toBeNull();
    expect(migrateRowData({ a: 1 }, [], ['b'])).toBeNull();
  });

  it('moves a renamed field with its value', () => {
    expect(migrateRowData({ a: 1, b: 2 }, [{ from: 'a', to: 'z' }], [])).toEqual({ z: 1, b: 2 });
  });

  it('drops a purged field', () => {
    expect(migrateRowData({ a: 1, b: 2 }, [], ['b'])).toEqual({ a: 1 });
  });

  it('renames before purging, so a purge cannot eat the moved value', () => {
    // `b` is purged and `a` is renamed onto it in the same save.
    expect(migrateRowData({ a: 1, b: 2 }, [{ from: 'a', to: 'c' }], ['b'])).toEqual({ c: 1 });
  });

  it('does not mutate the row it was given', () => {
    const data = { a: 1 };
    migrateRowData(data, [{ from: 'a', to: 'z' }], []);
    expect(data).toEqual({ a: 1 });
  });
});

describe('conditionalPatch', () => {
  const changes = { deletedColumns: [] as string[], prevDeleted: [] as string[], savedFields: new Set(['name']) };

  it('writes nothing when nothing changed', () => {
    expect(conditionalPatch(table(), changes, {}, [])).toEqual({});
  });

  it('writes deletedColumns when something is tracked', () => {
    const patch = conditionalPatch(table(), { ...changes, deletedColumns: ['note'] }, {}, []);
    expect(patch.deletedColumns).toEqual(['note']);
  });

  it('writes deletedColumns when a tracked set is being cleared', () => {
    const patch = conditionalPatch(table({ deletedColumns: ['note'] }), { ...changes, prevDeleted: ['note'] }, {}, []);
    expect(patch.deletedColumns).toEqual([]);
  });

  it('carries a filter across a rename', () => {
    const patch = conditionalPatch(table({ filters: { note: '>1' } }), { ...changes, savedFields: new Set(['comment']) }, { note: '>1' }, [{ from: 'note', to: 'comment' }]);
    expect(patch.filters).toEqual({ comment: '>1' });
  });

  it('drops the filter of a removed column', () => {
    const patch = conditionalPatch(table({ filters: { note: '>1' } }), changes, { note: '>1' }, []);
    expect(patch.filters).toEqual({});
  });

  it('leaves an unchanged filter map unwritten', () => {
    const patch = conditionalPatch(table({ filters: { name: 'x' } }), changes, { name: 'x' }, []);
    expect('filters' in patch).toBe(false);
  });
});

describe('saveStageError', () => {
  it('says nothing was changed when the first stage failed', () => {
    const msg = saveStageError('the column settings', [], new Error('disk full'));
    expect(msg).toContain('Could not save the column settings: disk full');
    expect(msg).toContain('Nothing was changed.');
  });

  it('names what landed when a later stage failed', () => {
    const msg = saveStageError('the row data', ['the column settings'], new Error('read-only'));
    expect(msg).toContain('Already written: the column settings');
    expect(msg).toContain('part-saved');
  });

  it('copes with a thrown non-Error', () => {
    expect(saveStageError('the row data', [], 'boom')).toContain('boom');
  });
});
