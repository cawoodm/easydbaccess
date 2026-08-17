import { describe, expect, it } from 'vitest';
import { ROW_COLLECTION, changeScopeOf } from '../../packages/shared/src/change-scope.js';

/**
 * The rule that decides how wide a `changed` broadcast goes.
 *
 * What this pins is the reason the rule exists: a row delete has to name the
 * table it emptied, or every open grid re-reads itself — once per chunk of a
 * chunked delete. The old browser rule read the REQUEST, which for a delete
 * carries only row ids, so it always went wide.
 */

const row = (tableId: string) => ({ id: 'r1', tableId, data: {}, updatedAt: 0 });

describe('changeScopeOf', () => {
  it('leaves a non-row collection unscoped — its subscribers are per-collection', () => {
    expect(changeScopeOf('tables', row('t1'))).toBeUndefined();
    expect(changeScopeOf('settings', { key: 'w1::x', workspaceId: 'w1' })).toBeUndefined();
  });

  it('scopes an insert, upsert or patch from the document it returned', () => {
    expect(changeScopeOf(ROW_COLLECTION, row('t7'))).toBe('t7');
  });

  it('scopes a remove from the table id the store reported', () => {
    // `EdbStore.remove` returns the table it found the row in — the request
    // itself only named the row id.
    expect(changeScopeOf(ROW_COLLECTION, 't3')).toBe('t3');
  });

  it('scopes a bulk write when every member names the same table', () => {
    expect(changeScopeOf(ROW_COLLECTION, [row('t2'), row('t2'), row('t2')])).toBe('t2');
    expect(changeScopeOf(ROW_COLLECTION, ['t2', 't2'])).toBe('t2');
  });

  it('goes wide when a batch spans two tables — a scope names one', () => {
    expect(changeScopeOf(ROW_COLLECTION, [row('t1'), row('t2')])).toBeUndefined();
    expect(changeScopeOf(ROW_COLLECTION, ['t1', 't2'])).toBeUndefined();
  });

  it('goes wide for a write that touched nothing, rather than guessing', () => {
    expect(changeScopeOf(ROW_COLLECTION, undefined)).toBeUndefined();
    expect(changeScopeOf(ROW_COLLECTION, null)).toBeUndefined();
    // A bulkRemove whose ids matched no row at all.
    expect(changeScopeOf(ROW_COLLECTION, [])).toBeUndefined();
  });

  it('goes wide when one member of a batch cannot be placed', () => {
    // Otherwise the unplaceable row's table would be left stale.
    expect(changeScopeOf(ROW_COLLECTION, [row('t1'), { id: 'r2' }])).toBeUndefined();
  });
});
