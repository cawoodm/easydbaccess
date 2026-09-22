import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '../../../packages/shared/src/index.js';
import { columnsFor, runSummary } from '../../../packages/renderer/src/plugins/run-scripts.js';

/**
 * The two pure rules behind the footer's **Run scripts** button: which columns
 * an answer selects, and what the run says afterwards. Everything else in that
 * plugin is dialogs and progress.
 */

const SRC = 'function render(row) { return 1; }';

function col(over: Partial<ColumnSpec> & { field: string }): ColumnSpec {
  return { label: over.field, type: 'string', ...over } as ColumnSpec;
}

const COLUMNS: ColumnSpec[] = [
  col({ field: 'plain' }),
  col({ field: 'on', script: SRC }),
  col({ field: 'alsoOn', script: SRC, scriptActive: true }),
  col({ field: 'parked', script: SRC, scriptActive: false }),
  col({ field: 'blank', script: '   ' }),
];

describe('columnsFor', () => {
  it('takes the enabled scripts, treating an absent switch as on', () => {
    expect(columnsFor(COLUMNS, 'enabled').map((c) => c.field)).toEqual(['on', 'alsoOn']);
  });

  it('takes the parked ones alone — the reason to park rather than delete', () => {
    expect(columnsFor(COLUMNS, 'disabled').map((c) => c.field)).toEqual(['parked']);
  });

  it('takes every scripted column for "all"', () => {
    expect(columnsFor(COLUMNS, 'all').map((c) => c.field)).toEqual(['on', 'alsoOn', 'parked']);
  });

  it('ignores a column with no script, and one whose script is whitespace', () => {
    expect(columnsFor(COLUMNS, 'all').map((c) => c.field)).not.toContain('plain');
    expect(columnsFor(COLUMNS, 'all').map((c) => c.field)).not.toContain('blank');
  });

  it('never runs on _error, which Validate owns and rewrites', () => {
    const withError = [...COLUMNS, col({ field: '_error', script: SRC })];
    expect(columnsFor(withError, 'all').map((c) => c.field)).not.toContain('_error');
  });
});

describe('runSummary', () => {
  it('adds the columns up', () => {
    const text = runSummary([
      { field: 'a', result: { written: 3, unchanged: 1, failed: 0, firstError: null } },
      { field: 'b', result: { written: 2, unchanged: 0, failed: 0, firstError: null } },
    ]);
    expect(text).toBe('5 cells written across 2 columns.');
  });

  it('names the first failure, wherever it came from', () => {
    const text = runSummary([
      { field: 'a', result: { written: 1, unchanged: 0, failed: 0, firstError: null } },
      { field: 'b', result: { written: 0, unchanged: 0, failed: 2, firstError: 'no name' } },
    ]);
    expect(text).toContain('2 failed');
    expect(text).toContain('no name');
  });
});
