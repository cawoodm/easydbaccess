import { describe, expect, it } from 'vitest';
import { uniqueTableName } from '../../../packages/renderer/src/import/land-tables.js';

describe('uniqueTableName', () => {
  it('keeps a free name unchanged', () => {
    expect(uniqueTableName([], 'places')).toBe('places');
    expect(uniqueTableName(['other'], 'places')).toBe('places');
  });

  it('appends -2 for the first clash', () => {
    expect(uniqueTableName(['places'], 'places')).toBe('places-2');
  });

  it('counts up past every taken suffix', () => {
    expect(uniqueTableName(['places', 'places-2', 'places-3'], 'places')).toBe('places-4');
  });

  it('skips a gap rather than reusing a taken later name', () => {
    // -2 is free, so it wins even though -3 exists.
    expect(uniqueTableName(['places', 'places-3'], 'places')).toBe('places-2');
  });

  it('compares case-insensitively', () => {
    // Two tables differing only in case is a trap: the workspace treats names
    // case-insensitively elsewhere, so a clash here must be a clash.
    expect(uniqueTableName(['Places'], 'places')).toBe('places-2');
    expect(uniqueTableName(['places'], 'PLACES')).toBe('PLACES-2');
  });

  it('falls back to "imported" for a blank name', () => {
    expect(uniqueTableName([], '')).toBe('imported');
    expect(uniqueTableName([], '   ')).toBe('imported');
    expect(uniqueTableName(['imported'], '')).toBe('imported-2');
  });

  it('trims the seed', () => {
    expect(uniqueTableName([], '  places  ')).toBe('places');
  });
});
