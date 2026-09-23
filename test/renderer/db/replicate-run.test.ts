import { describe, expect, it } from 'vitest';
import { nothingToSettle } from '../../../packages/renderer/src/db/edb/replicate-run.js';
import type { DiffCounts } from '../../../packages/shared/src/replicate.js';

/** All zero — nothing differs, nothing is one-sided. */
const ALL_SAME: DiffCounts = { same: 3, differs: 0, hereOnly: 0, diskOnly: 0 };

/** At least one thing differs. */
const SOME_DIFFER: DiffCounts = { same: 1, differs: 1, hereOnly: 0, diskOnly: 0 };

describe('nothingToSettle', () => {
  it('is true only when tables, templates and instances are all in step', () => {
    expect(nothingToSettle(ALL_SAME, ALL_SAME, ALL_SAME)).toBe(true);
  });

  it('is false when the tables differ, whatever the views say', () => {
    expect(nothingToSettle(SOME_DIFFER, ALL_SAME, ALL_SAME)).toBe(false);
  });

  it('is false when only the view TEMPLATES differ — the tables alone are not the whole answer', () => {
    expect(nothingToSettle(ALL_SAME, SOME_DIFFER, ALL_SAME)).toBe(false);
  });

  it('is false when only the view INSTANCES differ — the reported bug, one layer down: a chart added to an untouched table', () => {
    expect(nothingToSettle(ALL_SAME, ALL_SAME, SOME_DIFFER)).toBe(false);
  });

  it('is false when everything differs', () => {
    expect(nothingToSettle(SOME_DIFFER, SOME_DIFFER, SOME_DIFFER)).toBe(false);
  });
});
