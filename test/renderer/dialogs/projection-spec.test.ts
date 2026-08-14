import { describe, expect, it } from 'vitest';
import type { ProjectionSpec } from '@easydb/shared';
import {
  addComputedToModel,
  addSourceToModel,
  editorToSpec,
  removeSourceFromModel,
  seedJoinKeyFromBase,
  specToEditor,
  type ProjectionCandidate,
} from '../../../packages/renderer/src/dialogs/projection-spec.js';

const cand = (id: string, name: string, fields: string[]): ProjectionCandidate => ({
  id,
  name,
  columns: fields.map((f) => ({ field: f, label: f, type: 'string' as const })),
});

const people = cand('p1', 'People', ['name', 'deptId']);
const dept = cand('d1', 'Dept', ['id', 'label']);

/** A two-source spec with a filter and a TWO-key join — none of it UI-creatable. */
const richSpec: ProjectionSpec = {
  version: 1,
  sources: [
    { alias: 'p', tableName: 'People' },
    {
      alias: 'd',
      tableName: 'Dept',

      join: {
        type: 'left',
        on: [
          { field: 'id', eqAlias: 'p', eqField: 'deptId' },
          { field: 'label', eqAlias: 'p', eqField: 'name' },
        ],
      },
    },
  ],
  // The spec carries only the mapping; presentation lives on the table.
  columns: [
    { field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } },
    { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
  ],
  filters: { name: 'Al' },
};

function roundTrip(spec: ProjectionSpec): ProjectionSpec {
  const model = specToEditor('X', spec, [people, dept]);
  const built = editorToSpec(model);
  if (!built.ok) throw new Error(`expected a valid spec, got: ${built.error}`);
  return built.spec;
}

describe('specToEditor → editorToSpec round-trip', () => {
  it('is lossless for a spec carrying filters and a multi-key join', () => {
    expect(roundTrip(richSpec)).toEqual(richSpec);
  });

  it('preserves filters (the editor has no filter UI, so they must pass through)', () => {
    expect(roundTrip(richSpec).filters).toEqual({ name: 'Al' });
  });

  it('preserves every join key, not just the first', () => {
    expect(roundTrip(richSpec).sources[1]?.join?.on).toHaveLength(2);
  });
});

describe('specToEditor offers every source field', () => {
  /** A spec that selects only ONE of People's two fields. */
  const partial: ProjectionSpec = {
    version: 1,
    sources: [{ alias: 'p', tableName: 'People' }],
    columns: [{ field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } }],
  };

  it('lists unselected source fields as unticked, so they can be added later', () => {
    const model = specToEditor('X', partial, [people]);
    expect(model.columns.map((c) => [c.field, c.include])).toEqual([
      ['name', true],
      ['deptId', false], // was never in the projection — now offered
    ]);
  });

  it('offers a field the source table gained after the projection was made', () => {
    const grown: ProjectionCandidate = {
      ...people,
      columns: [...people.columns, { field: 'email', label: 'Email', type: 'string' }],
    };
    const model = specToEditor('X', partial, [grown]);
    expect(model.columns.find((c) => c.field === 'email')).toMatchObject({ include: false });
  });

  it('adds nothing to the spec until one is ticked', () => {
    // Loading and saving untouched must not silently widen the projection.
    const untouched = editorToSpec(specToEditor('X', partial, [people]));
    expect(untouched.ok).toBe(true);
    if (!untouched.ok) return;
    expect(untouched.spec.columns).toEqual(partial.columns);

    const model = specToEditor('X', partial, [people]);
    const ticked = editorToSpec({
      ...model,
      columns: model.columns.map((c) => (c.field === 'deptId' ? { ...c, include: true } : c)),
    });
    expect(ticked.ok).toBe(true);
    if (!ticked.ok) return;
    expect(ticked.spec.columns.map((c) => c.field)).toEqual(['name', 'deptid']);
  });

  it('keeps a selected column visible when its source field has vanished', () => {
    const gone: ProjectionCandidate = { id: 'p1', name: 'People', columns: [] };
    const model = specToEditor('X', partial, [gone]);
    expect(model.columns).toHaveLength(1);
    expect(model.columns[0]).toMatchObject({ field: 'name', include: true });
  });

  it('offers each copy of a repeated table separately', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'a', tableName: 'People' },
        { alias: 'b', tableName: 'People', join: { type: 'left', on: [{ field: 'name', eqAlias: 'a', eqField: 'name' }] } },
      ],
      columns: [{ field: 'name', from: { kind: 'source', alias: 'a', field: 'name' } }],
    };
    const model = specToEditor('X', spec, [people]);
    expect(model.columns.map((c) => [c.alias, c.field, c.include])).toEqual([
      ['a', 'name', true],
      ['a', 'deptId', false],
      ['b', 'name', false],
      ['b', 'deptId', false],
    ]);
  });
});

describe('editorToSpec: output field names', () => {
  it('keeps an existing output field verbatim across an edit', () => {
    // The table's ColumnSpec, filters, sort and any View template are keyed by
    // the output field, so it must survive re-saving the join untouched.
    const model = specToEditor('X', richSpec, [people, dept]);
    const built = editorToSpec(model);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.columns.map((c) => c.field)).toEqual(['name', 'dept']);
  });

  it('names a new column after its SOURCE field, and carries no presentation', () => {
    const model = addSourceToModel({ name: 'X', sources: [], columns: [] }, people);
    const built = editorToSpec(model);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.columns.map((c) => c.field)).toEqual(['name', 'deptid']);
    // No label/type/hidden — those are inherited onto the table's own columns.
    expect(built.spec.columns[0]).toEqual({
      field: 'name',
      from: { kind: 'source', alias: 'a', field: 'name' },
    });
  });

  it('names computed columns without needing a label', () => {
    let model = addSourceToModel({ name: 'X', sources: [], columns: [] }, people);
    model = addComputedToModel(addComputedToModel(model));
    const built = editorToSpec(model);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.columns.slice(-2).map((c) => c.field)).toEqual(['computed', 'computed_2']);
  });
});

describe('joining the same table more than once', () => {
  // Simon Willison's TIL shape: `similarities` references `til` twice.
  const similarities: ProjectionCandidate = {
    id: 's1',
    name: 'similarities',
    columns: [
      { field: 'id', label: 'Id', type: 'string' },
      { field: 'other_id', label: 'Other Id', type: 'string' },
      { field: 'score', label: 'Score', type: 'number' },
    ],
  };
  const til: ProjectionCandidate = {
    id: 't1',
    name: 'til',
    columns: [
      { field: 'path', label: 'Path', type: 'string', unique: true },
      { field: 'title', label: 'Title', type: 'string' },
    ],
  };

  function build() {
    let model = addSourceToModel({ name: 'Similar TILs', sources: [], columns: [] }, similarities);
    model = addSourceToModel(model, til); // b
    model = addSourceToModel(model, til); // c — the same table again
    return model;
  }

  it('adds two sources for one table, each with its own alias and join key', () => {
    const built = editorToSpec(build());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const [base, left, right] = built.spec.sources;
    expect([base?.alias, left?.alias, right?.alias]).toEqual(['a', 'b', 'c']);
    expect(left?.tableName).toBe('til');
    expect(right?.tableName).toBe('til');
    // Each join lands on a DIFFERENT reference column of the base.
    expect(left?.join?.on).toEqual([{ field: 'path', eqAlias: 'a', eqField: 'id' }]);
    expect(right?.join?.on).toEqual([{ field: 'path', eqAlias: 'a', eqField: 'other_id' }]);
  });

  it('disambiguates the repeated table’s column labels and output fields', () => {
    const built = editorToSpec(build());
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Picker labels disambiguate the repeat; the spec itself carries only fields.
    const labels = build()
      .columns.filter((c) => c.field === 'title')
      .map((c) => c.label);
    expect(labels).toEqual(['Title', 'Title (c)']);
    // Output field names stay unique too, so downstream state cannot collide.
    expect(new Set(built.spec.columns.map((c) => c.field)).size).toBe(built.spec.columns.length);
  });

  it('removing one copy leaves the other intact', () => {
    const pruned = removeSourceFromModel(build(), 'b');
    expect(pruned.sources.map((s) => s.alias)).toEqual(['a', 'c']);
    expect(editorToSpec(pruned).ok).toBe(true);
  });
});

describe('removeSourceFromModel', () => {
  it('cascades to sources whose join referenced the removed one', () => {
    // base a=People, b=Dept joined on a, c=Extra joined on b.
    let model = addSourceToModel({ name: 'X', sources: [], columns: [] }, people);
    model = addSourceToModel(model, dept);
    model = addSourceToModel(model, cand('e1', 'Extra', ['id', 'note']));
    // Point Extra's join at Dept (b) so it depends on it.
    const withDep = {
      ...model,
      sources: model.sources.map((s) => (s.alias === 'c' && s.join ? { ...s, join: { ...s.join, otherAlias: 'b' } } : s)),
    };

    const pruned = removeSourceFromModel(withDep, 'b');

    // Both Dept and its dependent Extra are gone — no dangling alias remains.
    expect(pruned.sources.map((s) => s.alias)).toEqual(['a']);
    expect(pruned.columns.every((c) => c.computed || c.alias === 'a')).toBe(true);
    // And what is left still builds.
    expect(editorToSpec(pruned).ok).toBe(true);
  });
});

describe('editorToSpec: validation', () => {
  it('rejects a join referencing a source that is not earlier in the list', () => {
    const model = specToEditor('X', richSpec, [people, dept]);
    // Simulate a dangling alias (what a naive source removal used to leave).
    const broken = {
      ...model,
      sources: model.sources.map((s) => (s.alias === 'd' && s.join ? { ...s, join: { ...s.join, otherAlias: 'gone' } } : s)),
    };
    const built = editorToSpec(broken);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatch(/no longer part of this projection/i);
  });

  it('rejects a column whose source alias is gone', () => {
    const model = specToEditor('X', richSpec, [people, dept]);
    const built = editorToSpec({ ...model, sources: [model.sources[0]!] });
    expect(built.ok).toBe(false);
  });

  it('requires a name, a source, and at least one column', () => {
    expect(editorToSpec({ name: ' ', sources: [], columns: [] }).ok).toBe(false);
    expect(editorToSpec({ name: 'X', sources: [], columns: [] }).ok).toBe(false);
    const m = addSourceToModel({ name: 'X', sources: [], columns: [] }, people);
    expect(editorToSpec({ ...m, columns: m.columns.map((c) => ({ ...c, include: false })) }).ok).toBe(false);
  });
});

describe('seedJoinKeyFromBase', () => {
  /** A two-source model: base `People`, joined `Dept`, keys guessed. */
  function twoSources() {
    const people: ProjectionCandidate = {
      id: 'p',
      name: 'People',
      columns: cand('p', 'People', ['name', 'deptId', 'regionId']).columns,
    };
    const dept: ProjectionCandidate = cand('d', 'Dept', ['DeptID', 'label', 'regionId']);
    return addSourceToModel(addSourceToModel({ name: '', sources: [], columns: [] }, people), dept);
  }

  it('keys the join on the field the drag named, on both sides', () => {
    // The user pointed at the answer; a heuristic that "usually" agrees is not
    // good enough when two columns are plausible keys (here `regionId` is too).
    const m = seedJoinKeyFromBase(twoSources(), 'deptId');
    const join = m.sources[1]?.join;
    expect(join?.otherAlias).toBe(m.sources[0]?.alias);
    expect(join?.otherField).toBe('deptId');
    // Matched case-insensitively — the joined table spells it `DeptID`.
    expect(join?.thisField).toBe('DeptID');
  });

  it('prefers an exact name match over a case-insensitive one', () => {
    const base = cand('a', 'A', ['id']);
    const other = cand('b', 'B', ['ID', 'id']);
    const m = seedJoinKeyFromBase(addSourceToModel(addSourceToModel({ name: '', sources: [], columns: [] }, base), other), 'id');
    expect(m.sources[1]?.join?.thisField).toBe('id');
  });

  it('leaves the guess alone when the joined table has no such column', () => {
    // Overwriting one side only would leave a join that matches nothing — worse
    // than the heuristic's answer, which at least names two real fields.
    const before = twoSources();
    const after = seedJoinKeyFromBase(before, 'nosuchfield');
    expect(after).toBe(before);
  });

  it('does nothing to a model with only a base, or with no field named', () => {
    const only = addSourceToModel({ name: '', sources: [], columns: [] }, cand('p', 'People', ['deptId']));
    expect(seedJoinKeyFromBase(only, 'deptId')).toBe(only);
    const two = twoSources();
    expect(seedJoinKeyFromBase(two, '')).toBe(two);
  });

  it('does not disturb the columns the sources brought', () => {
    const before = twoSources();
    const after = seedJoinKeyFromBase(before, 'deptId');
    expect(after.columns).toEqual(before.columns);
  });
});
