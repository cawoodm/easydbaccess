import { beforeEach, describe, expect, it } from 'vitest';
import { forgetRowRequest, narrowsRows, rememberRowRequest, rowRequestOf } from '../../../packages/renderer/src/table/visible-request.js';
import type { RowRequest } from '../../../packages/renderer/src/db/row-reader.js';
import type { ColumnSpec } from '../../../packages/shared/src/index.js';

/**
 * What "visible" means in a table window, as the grid publishes it.
 *
 * The delete button reads this to decide whether to OFFER "Delete Visible Data" at
 * all: an option that deletes the same rows as the one above it is a trap, not a
 * choice. A sort or a page is not narrowing — only a filter or a search is.
 */

const COLUMNS: ColumnSpec[] = [{ field: 'name', label: 'Name', type: 'string' }];
const req = (over: Partial<RowRequest> = {}): RowRequest => ({ columns: COLUMNS, ...over });

describe('rememberRowRequest', () => {
  beforeEach(() => {
    forgetRowRequest('t1');
    forgetRowRequest('t2');
  });

  it('gives back what was published, per table', () => {
    rememberRowRequest('t1', req({ search: 'ada' }));
    rememberRowRequest('t2', req({ filters: { name: 'bo' } }));
    expect(rowRequestOf('t1')?.search).toBe('ada');
    expect(rowRequestOf('t2')?.filters).toEqual({ name: 'bo' });
  });

  it('knows nothing about a table whose grid never ran', () => {
    expect(rowRequestOf('t1')).toBeUndefined();
  });

  it('keeps only the latest — the request is a live state, not a history', () => {
    rememberRowRequest('t1', req({ search: 'first' }));
    rememberRowRequest('t1', req({ search: 'second' }));
    expect(rowRequestOf('t1')?.search).toBe('second');
  });

  it('ignores an empty table id rather than keying on one', () => {
    rememberRowRequest('', req({ search: 'ada' }));
    expect(rowRequestOf('')).toBeUndefined();
  });

  it('forgets a table, so a deleted one leaves nothing behind', () => {
    rememberRowRequest('t1', req({ search: 'ada' }));
    forgetRowRequest('t1');
    expect(rowRequestOf('t1')).toBeUndefined();
  });
});

describe('narrowsRows', () => {
  it('is false for no request at all', () => {
    expect(narrowsRows(undefined)).toBe(false);
  });

  it('is false for a plain read', () => {
    expect(narrowsRows(req())).toBe(false);
  });

  it('is true for a search', () => {
    expect(narrowsRows(req({ search: 'ada' }))).toBe(true);
  });

  it('is true for a filter', () => {
    expect(narrowsRows(req({ filters: { name: 'ada' } }))).toBe(true);
  });

  it('ignores a filter that is only whitespace, as the reader does', () => {
    expect(narrowsRows(req({ filters: { name: '   ' } }))).toBe(false);
    expect(narrowsRows(req({ search: '  ' }))).toBe(false);
  });

  it('ignores an empty filter map, which is what a cleared funnel leaves', () => {
    expect(narrowsRows(req({ filters: {} }))).toBe(false);
  });

  it('is false for a sort or a page — neither changes which rows match', () => {
    expect(narrowsRows(req({ sort: [{ field: 'name', asc: true }] }))).toBe(false);
    expect(narrowsRows(req({ offset: 500, limit: 500 }))).toBe(false);
  });
});
