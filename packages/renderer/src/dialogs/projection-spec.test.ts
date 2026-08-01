import { describe, expect, it } from 'vitest';
import type { ProjectionSpec } from '@easydb/shared';
import {
  addSourceToModel,
  editorToSpec,
  removeSourceFromModel,
  specToEditor,
  type ProjectionCandidate,
} from './projection-spec.js';

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
    { alias: 'p', tableName: 'People', tableId: 'p1' },
    {
      alias: 'd',
      tableName: 'Dept',
      tableId: 'd1',
      join: {
        type: 'left',
        on: [
          { field: 'id', eqAlias: 'p', eqField: 'deptId' },
          { field: 'label', eqAlias: 'p', eqField: 'name' },
        ],
      },
    },
  ],
  columns: [
    { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } },
    { field: 'dept', label: 'Dept', type: 'string', from: { kind: 'source', alias: 'd', field: 'label' } },
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

describe('editorToSpec: output field names', () => {
  it('keeps the existing output field when a label is renamed', () => {
    const model = specToEditor('X', richSpec, [people, dept]);
    const columns = model.columns.map((c) => (c.label === 'Name' ? { ...c, label: 'Full Name' } : c));
    const built = editorToSpec({ ...model, columns });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const col = built.spec.columns[0];
    // Downstream state (width / hidden / sort / filters / views) is keyed by
    // `field`, so only the label may change.
    expect(col?.field).toBe('name');
    expect(col?.label).toBe('Full Name');
  });

  it('mints a slug for a genuinely new column', () => {
    const model = addSourceToModel({ name: 'X', sources: [], columns: [] }, people);
    const built = editorToSpec(model);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.columns.map((c) => c.field)).toEqual(['name', 'deptid']);
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
    const titles = built.spec.columns.filter((c) => c.label.startsWith('Title'));
    expect(titles.map((c) => c.label)).toEqual(['Title', 'Title (c)']);
    // Output field names stay unique too, so downstream state cannot collide.
    expect(new Set(built.spec.columns.map((c) => c.field)).size).toBe(built.spec.columns.length);
  });

  it('removing one copy leaves the other intact', () => {
    const pruned = removeSourceFromModel(build(), 'b');
    expect(pruned.sources.map((s) => s.alias)).toEqual(['a', 'c']);
    expect(editorToSpec(pruned).ok).toBe(true);
  });
});

describe('hidden columns', () => {
  it('copies a hidden source column into the projection as hidden', () => {
    const withHidden: ProjectionCandidate = {
      id: 'p1',
      name: 'People',
      columns: [
        { field: 'name', label: 'name', type: 'string' },
        { field: 'secret', label: 'secret', type: 'string', hidden: true },
      ],
    };
    const built = editorToSpec(addSourceToModel({ name: 'X', sources: [], columns: [] }, withHidden));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // Both columns are present; only the hidden one is flagged.
    expect(built.spec.columns.map((c) => [c.field, c.hidden ?? false])).toEqual([
      ['name', false],
      ['secret', true],
    ]);
  });

  it('hides rowid even when the source table still shows it', () => {
    // A Datasette table imported before rowid was hidden at the source.
    const legacy: ProjectionCandidate = {
      id: 'd9',
      name: 'Legacy',
      columns: [
        { field: 'rowid', label: 'Rowid', type: 'number' },
        { field: 'title', label: 'Title', type: 'string' },
      ],
    };
    const built = editorToSpec(addSourceToModel({ name: 'X', sources: [], columns: [] }, legacy));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.columns.find((c) => c.field === 'rowid')?.hidden).toBe(true);
    expect(built.spec.columns.find((c) => c.field === 'title')?.hidden).toBeUndefined();
  });

  it('survives an edit round-trip', () => {
    const spec: ProjectionSpec = {
      version: 1,
      // `tableId` is the resolution hint the editor refreshes from the candidate.
      sources: [{ alias: 'p', tableName: 'People', tableId: 'p1' }],
      columns: [
        { field: 'name', label: 'Name', type: 'string', from: { kind: 'source', alias: 'p', field: 'name' } },
        { field: 'rowid', label: 'Rowid', type: 'number', hidden: true, from: { kind: 'source', alias: 'p', field: 'rowid' } },
      ],
    };
    expect(roundTrip(spec)).toEqual(spec);
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
      sources: model.sources.map((s) =>
        s.alias === 'c' && s.join ? { ...s, join: { ...s.join, otherAlias: 'b' } } : s,
      ),
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
      sources: model.sources.map((s) =>
        s.alias === 'd' && s.join ? { ...s, join: { ...s.join, otherAlias: 'gone' } } : s,
      ),
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
    expect(editorToSpec({ ...m, columns: m.columns.map((c) => ({ ...c, include: false })) }).ok).toBe(
      false,
    );
  });
});
