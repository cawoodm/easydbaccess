import { describe, expect, it, vi } from 'vitest';
import { countWorkspaceContents, deleteWorkspace, describeWorkspaceContents } from '../../../packages/renderer/src/db/delete-workspace.js';
import { cloneWorkspace } from '../../../packages/renderer/src/db/clone-workspace.js';
import type { EasydbStoreBridge } from '../../../packages/renderer/src/db/data-store-bridge.js';
import type { WorkspaceContents } from '@easydb/shared';

/**
 * What survives of this suite is the message formatter, which is pure and is
 * still the thing a user reads before confirming a delete.
 *
 * The walking itself moved into `EdbStore` when the browser became SQLite —
 * deleting is now a DROP per table plus three DELETEs, and it is covered
 * against a real database in `test/shared/edb-workspaces.test.ts`. What is left
 * to check here is that these wrappers actually delegate, and that they fail
 * loudly on a transport too old to carry the operation rather than appearing to
 * succeed.
 */

const CONTENTS: WorkspaceContents = { tables: 1, rows: 2, views: 3, templates: 4, settings: 5 };

function fakeBridge(over: Partial<EasydbStoreBridge> = {}): EasydbStoreBridge {
  return {
    countWorkspaceContents: vi.fn(async () => CONTENTS),
    deleteWorkspace: vi.fn(async () => CONTENTS),
    cloneWorkspace: vi.fn(async () => 'copy'),
    ...over,
  } as unknown as EasydbStoreBridge;
}

describe('delegation to the store', () => {
  it('counts rows by default — the SQL count is cheap enough to always ask', () => {
    // Under Dexie this defaulted OFF: counting a 609k-row workspace cost 14
    // seconds and made the confirm dialog read as a dead button.
    const bridge = fakeBridge();
    void countWorkspaceContents(bridge, 'w1');
    expect(bridge.countWorkspaceContents).toHaveBeenCalledWith('w1', { countRows: true });
  });

  it('still lets a caller opt out of the row count', () => {
    const bridge = fakeBridge();
    void countWorkspaceContents(bridge, 'w1', { countRows: false });
    expect(bridge.countWorkspaceContents).toHaveBeenCalledWith('w1', { countRows: false });
  });

  it('passes the delete straight through and returns what went', async () => {
    const bridge = fakeBridge();
    await expect(deleteWorkspace(bridge, 'w1')).resolves.toEqual(CONTENTS);
    expect(bridge.deleteWorkspace).toHaveBeenCalledWith('w1');
  });

  it('passes the clone straight through and returns the new id', async () => {
    const bridge = fakeBridge();
    const opts = { from: 'a', to: 'b', name: 'B', mode: 'all' as const };
    await expect(cloneWorkspace(bridge, opts)).resolves.toBe('copy');
    expect(bridge.cloneWorkspace).toHaveBeenCalledWith(opts);
  });

  it('throws on a transport that cannot do it, rather than looking like it worked', async () => {
    // These are optional on the bridge so an older Electron preload degrades
    // detectably. Silently resolving would report a delete that never happened.
    // An older preload simply lacks the properties, so the fake omits them
    // rather than setting them to undefined.
    const bare = {} as EasydbStoreBridge;
    await expect(countWorkspaceContents(bare, 'w1')).rejects.toThrow(/cannot count/);
    await expect(deleteWorkspace(bare, 'w1')).rejects.toThrow(/cannot delete/);
    await expect(cloneWorkspace(bare, { from: 'a', to: 'b', name: 'B', mode: 'all' })).rejects.toThrow(/cannot clone/);
  });
});

describe('describeWorkspaceContents', () => {
  const contents = (over: Partial<WorkspaceContents> = {}): WorkspaceContents => ({ tables: 1, rows: 1, views: 1, templates: 1, settings: 1, ...over });

  it('names every part, singular', () => {
    expect(describeWorkspaceContents(contents())).toBe('1 table, 1 row, 1 view, 1 setting');
  });

  it('pluralizes, including zero', () => {
    expect(describeWorkspaceContents(contents({ tables: 2, rows: 0, views: 3, settings: 0 }))).toBe('2 tables, 0 rows, 3 views, 0 settings');
  });

  it('groups a big row total', () => {
    // Built with `toLocaleString` so the expectation follows the machine's locale
    // rather than asserting one separator.
    expect(describeWorkspaceContents(contents({ rows: 609_283 }))).toContain(`${(609_283).toLocaleString()} rows`);
  });

  it('says "and all their rows" when the rows were not counted', () => {
    expect(describeWorkspaceContents(contents({ rows: -1 }))).toBe('1 table, 1 view, 1 setting and all their rows');
  });

  it('leaves the templates out — a template is workspace-global chrome, not content the user put there', () => {
    expect(describeWorkspaceContents(contents({ templates: 7 }))).not.toContain('7');
  });
});
