import { describe, expect, it } from 'vitest';
import type { ColumnSpec } from '../../../packages/shared/src/index.js';
import { isScriptEnabled, runSummary, scriptedColumns } from '../../../packages/renderer/src/plugins/run-scripts.js';

/**
 * The pure rules behind the footer's **Run** button: which columns it offers,
 * which of them are live, and what the run says afterwards. Everything else in
 * that plugin is dialogs and progress.
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

describe('scriptedColumns', () => {
  it('offers every scripted column, enabled or not — the picker decides, not us', () => {
    expect(scriptedColumns(COLUMNS).map((c) => c.field)).toEqual(['on', 'alsoOn', 'parked']);
  });

  it('ignores a column with no script, and one whose script is whitespace', () => {
    const fields = scriptedColumns(COLUMNS).map((c) => c.field);
    expect(fields).not.toContain('plain');
    expect(fields).not.toContain('blank');
  });

  it('never runs on _error, which Validate owns and rewrites', () => {
    const withError = [...COLUMNS, col({ field: '_error', script: SRC })];
    expect(scriptedColumns(withError).map((c) => c.field)).not.toContain('_error');
  });
});

describe('isScriptEnabled', () => {
  it('treats an absent switch as on', () => {
    expect(isScriptEnabled(col({ field: 'on', script: SRC }))).toBe(true);
  });

  it('reads an explicit switch both ways', () => {
    expect(isScriptEnabled(col({ field: 'a', script: SRC, scriptActive: true }))).toBe(true);
    expect(isScriptEnabled(col({ field: 'b', script: SRC, scriptActive: false }))).toBe(false);
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
    // A summary reads a tally, never the rows — which is why the two are
    // separate types.
    expect(text).toContain('2 failed');
    expect(text).toContain('no name');
  });
});
