import { describe, expect, it } from 'vitest';
import { countSuffix, importSuffix } from '../../../packages/renderer/src/window-mgr/panel-title.js';

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

/**
 * While a table's rows import in the background, the titlebar carries the
 * progress — it is the only thing a minimized window shows, and the tables
 * created by phase 1 of an import all start minimized.
 */
describe('importSuffix', () => {
  // Counts are grouped with `toLocaleString`, so the separator is the reader's
  // own (a Swiss locale gives 120’000, not 120,000). The expectations build
  // the same way rather than hard-coding one locale's punctuation.
  const n = (v: number): string => v.toLocaleString();

  it('shows written/total and a whole percentage', () => {
    expect(importSuffix(120000, 609283)).toBe(` (${n(120000)}/${n(609283)} · 20%)`);
  });

  it('starts at 0% and ends at exactly 100%', () => {
    expect(importSuffix(0, 500)).toBe(` (${n(0)}/${n(500)} · 0%)`);
    expect(importSuffix(500, 500)).toBe(` (${n(500)}/${n(500)} · 100%)`);
  });

  it('never shows more than 100%, even if the source count was stale', () => {
    expect(importSuffix(600, 500)).toBe(` (${n(600)}/${n(500)} · 100%)`);
  });

  it('drops the percentage when the total is unknown', () => {
    expect(importSuffix(1234, 0)).toBe(` (${n(1234)})`);
  });
});
