import { describe, expect, it } from 'vitest';
import { countSuffix } from './panel-title.js';

describe('countSuffix', () => {
  it('shows a bare total when nothing is filtered', () => {
    expect(countSuffix(3, 3)).toBe(' (3)');
    expect(countSuffix(0, 0)).toBe(' (0)');
  });

  it('shows visible/total when a search or filter narrows the set', () => {
    expect(countSuffix(1, 3)).toBe(' (1/3)');
    expect(countSuffix(0, 12)).toBe(' (0/12)');
  });

  it('is empty until a count is known (negative sentinel)', () => {
    expect(countSuffix(-1, -1)).toBe('');
    expect(countSuffix(-1, 5)).toBe('');
    expect(countSuffix(5, -1)).toBe('');
  });
});
