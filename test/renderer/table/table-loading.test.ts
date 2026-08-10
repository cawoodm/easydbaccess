import { describe, expect, it, beforeEach } from 'vitest';
import { setTableLoading, tableLoadingState } from '../../../packages/renderer/src/table/table-loading.js';

/**
 * A multi-table import marks every table loading up front and fills them one at
 * a time, so the window for the last table mounts long after its own signal was
 * sent. The state has to outlive the event or that grid shows nothing.
 */
describe('table-loading', () => {
  beforeEach(() => {
    setTableLoading('t1', false);
    setTableLoading('t2', false);
  });

  it('remembers a table that is loading, for a grid that mounts later', () => {
    expect(tableLoadingState('t1')).toBeUndefined();
    setTableLoading('t1', true);
    expect(tableLoadingState('t1')).toBeNull(); // loading, fraction unknown
  });

  it('keeps the last fraction so a late grid starts determinate', () => {
    setTableLoading('t1', true, 0.4);
    expect(tableLoadingState('t1')).toBe(0.4);
  });

  it('forgets a table once it is done', () => {
    setTableLoading('t1', true, 0.9);
    setTableLoading('t1', false);
    expect(tableLoadingState('t1')).toBeUndefined();
  });

  it('tracks tables independently', () => {
    setTableLoading('t1', true, 0.5);
    setTableLoading('t2', true);
    expect(tableLoadingState('t1')).toBe(0.5);
    expect(tableLoadingState('t2')).toBeNull();
  });

  it('ignores an empty table id', () => {
    setTableLoading('', true);
    expect(tableLoadingState('')).toBeUndefined();
  });

  // Reporting progress must never break the work it reports on, so a run with no
  // `document` records the state and skips the event. (The event itself is what
  // grids already mounted listen to — covered by the e2e suite.)
  it('records state without a document', () => {
    expect(() => setTableLoading('t1', true, 0.1)).not.toThrow();
    expect(tableLoadingState('t1')).toBe(0.1);
  });
});
