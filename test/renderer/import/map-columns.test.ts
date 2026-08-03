import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '@easydb/shared';
import {
  guessMapping,
  mapRowsToTarget,
} from '../../../packages/renderer/src/import/map-columns.js';

const col = (field: string, label = field, type: ColumnSpec['type'] = 'string'): ColumnSpec => ({
  field,
  label,
  type,
});

/** Enough of csv-import's `coerce` to prove the type is applied. */
const coerce = (raw: string, type: ColumnSpec['type']): unknown => {
  const s = raw.trim();
  if (type === 'number') return s === '' ? null : Number(s);
  if (type === 'boolean') return s === '' ? null : s.toLowerCase() === 'true';
  return s;
};

describe('guessMapping', () => {
  const target = [col('name'), col('city'), col('pop', 'Population', 'number')];

  it('matches on the field name, ignoring case and space', () => {
    expect(guessMapping([' City ', 'NAME'], target)).toEqual(['city', 'name']);
  });

  it('matches on the label when the field does not', () => {
    expect(guessMapping(['Population'], target)).toEqual(['pop']);
  });

  it('falls back to the same position — what the old append always did', () => {
    expect(guessMapping(['a', 'b', 'c'], target)).toEqual(['name', 'city', 'pop']);
  });

  it('never feeds one target column twice', () => {
    // "name" matches by name, which claims it before the positional pass runs.
    // The first incoming column then has no guess at all — it is NOT pushed on
    // to the next free target, because a guess that far from the evidence is
    // worse than leaving the choice to the user.
    const out = guessMapping(['x', 'name'], [col('name'), col('other')]);
    expect(out).toEqual(['', 'name']);
  });

  it('leaves an incoming column past the target unmapped', () => {
    expect(guessMapping(['a', 'b', 'c', 'd'], [col('a')])).toEqual(['a', '', '', '']);
  });

  it('prefers a field match over another column whose label collides with it', () => {
    // "code" is one column's field and another's label — the field wins.
    const cols = [col('code'), col('id', 'code')];
    expect(guessMapping(['code'], cols)).toEqual(['code']);
  });
});

describe('mapRowsToTarget', () => {
  const target = [col('name'), col('pop', 'Population', 'number')];

  it('routes cells through the mapping and coerces by target type', () => {
    const rows = mapRowsToTarget([['12000', 'Bern']], target, ['pop', 'name'], coerce);
    expect(rows).toEqual([{ pop: 12000, name: 'Bern' }]);
  });

  it('drops a column mapped to nothing', () => {
    const rows = mapRowsToTarget([['Bern', 'ignored']], target, ['name', ''], coerce);
    expect(rows).toEqual([{ name: 'Bern' }]);
  });

  it('leaves an unfed target column absent rather than blank', () => {
    const rows = mapRowsToTarget([['Bern']], target, ['name'], coerce);
    expect(Object.keys(rows[0]!)).toEqual(['name']);
  });

  it('treats a missing cell as empty', () => {
    const rows = mapRowsToTarget([['Bern']], target, ['name', 'pop'], coerce);
    expect(rows[0]).toEqual({ name: 'Bern', pop: null });
  });

  it('ignores a mapping to a field the table no longer has', () => {
    const rows = mapRowsToTarget([['Bern', 'x']], target, ['name', 'gone'], coerce);
    expect(rows).toEqual([{ name: 'Bern' }]);
  });
});
