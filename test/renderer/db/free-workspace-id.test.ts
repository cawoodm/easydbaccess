import { describe, expect, it } from 'vitest';
import { freeWorkspaceId, slugifyWorkspace } from '../../../packages/renderer/src/db/edb/space-resolve.js';

/**
 * The id a second copy of a workspace gets.
 *
 * A dropped `northwind.edb` whose workspace is already here can be kept beside it,
 * and two workspaces cannot share an id — so one has to be found before anything
 * is written.
 */
describe('freeWorkspaceId', () => {
  it('leaves an unused id alone', () => {
    expect(freeWorkspaceId('northwind', new Set())).toBe('northwind');
    expect(freeWorkspaceId('northwind', new Set(['sales']))).toBe('northwind');
  });

  it('starts at 2, because the one already there is the first', () => {
    expect(freeWorkspaceId('northwind', new Set(['northwind']))).toBe('northwind-2');
  });

  it('keeps counting past the copies that exist', () => {
    expect(freeWorkspaceId('northwind', new Set(['northwind', 'northwind-2', 'northwind-3']))).toBe('northwind-4');
  });

  it('skips no gap it does not have to', () => {
    // `-2` gone, `-3` still there: the free id is the first free one, not the next
    // after the highest.
    expect(freeWorkspaceId('northwind', new Set(['northwind', 'northwind-3']))).toBe('northwind-2');
  });

  it('produces ids a workspace NAME would slug to', () => {
    // The app derives an id from a name, so a generated id has to be one a name
    // could have produced — otherwise the two conventions drift apart.
    const id = freeWorkspaceId('northwind', new Set(['northwind']));
    expect(slugifyWorkspace(id)).toBe(id);
    expect(slugifyWorkspace('northwind (2)')).toBe(id);
  });
});
