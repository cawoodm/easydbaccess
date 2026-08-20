import { describe, expect, it } from 'vitest';
import { folderConflicts, isEmptyWorkspace, mergeWorkspaceList, partitionConflicts, workspaceLabel, type FolderWorkspace } from '../../../packages/renderer/src/db/edb/folder-index.js';

/**
 * Merging the connected folder's workspaces into the list the selector shows.
 *
 * The scenario throughout: this tab has `local.edb` open holding `scratch` and
 * `sales`, and the folder also holds `sales.edb` and `demo.edb`. So `sales`
 * exists twice — that is the conflict the user gets prompted about.
 */

const OPEN = [
  { id: 'scratch', name: 'scratch' },
  { id: 'sales', name: 'sales' },
];

const FOLDER: FolderWorkspace[] = [
  { id: 'sales', name: 'sales', file: 'sales.edb' },
  { id: 'demo', name: 'demo', file: 'demo.edb' },
];

describe('mergeWorkspaceList', () => {
  it('lists the open database first, unqualified', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'local.edb');
    expect(merged.slice(0, 2)).toEqual([
      { id: 'sales', name: 'sales' },
      { id: 'scratch', name: 'scratch' },
    ]);
  });

  it('labels a workspace from another file with that file', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'local.edb');
    expect(merged.filter((e) => e.file !== undefined)).toEqual([
      { id: 'demo', name: 'demo', file: 'demo.edb' },
      { id: 'sales', name: 'sales', file: 'sales.edb' },
    ]);
  });

  it('shows a clashing name twice, so Cancel leaves both reachable', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'local.edb');
    expect(merged.filter((e) => e.id === 'sales')).toHaveLength(2);
  });

  it('does not list the open file twice over', () => {
    // Scanning the folder finds the file this tab already has open. Its
    // workspaces are in the open database already, so the entry is dropped.
    const merged = mergeWorkspaceList([{ id: 'sales', name: 'sales' }], FOLDER, 'sales.edb');
    expect(merged).toEqual([
      { id: 'sales', name: 'sales' },
      { id: 'demo', name: 'demo', file: 'demo.edb' },
    ]);
  });

  it('survives two scans of the same folder without doubling', () => {
    const merged = mergeWorkspaceList([], [...FOLDER, ...FOLDER], 'local.edb');
    expect(merged).toHaveLength(2);
  });

  it('is just the open database when no folder is connected', () => {
    expect(mergeWorkspaceList(OPEN, [], 'local.edb')).toEqual([
      { id: 'sales', name: 'sales' },
      { id: 'scratch', name: 'scratch' },
    ]);
  });

  it('carries a title through, from the open database and from a file', () => {
    const merged = mergeWorkspaceList([{ id: 'sales', name: 'sales', title: 'Sales 2026' }], [{ id: 'demo', name: 'demo', title: 'The Demo', file: 'demo.edb' }], 'local.edb');
    expect(merged).toEqual([
      { id: 'sales', name: 'sales', title: 'Sales 2026' },
      { id: 'demo', name: 'demo', title: 'The Demo', file: 'demo.edb' },
    ]);
  });

  it('sorts by what is shown, not by the technical name', () => {
    // `zulu` is titled "Alpha", so it comes first. Sorting on `name` would put it
    // last and the list would look unsorted to the only person reading it.
    const merged = mergeWorkspaceList(
      [
        { id: 'zulu', name: 'zulu', title: 'Alpha' },
        { id: 'mike', name: 'mike' },
      ],
      [],
      'local.edb',
    );
    expect(merged.map((e) => e.id)).toEqual(['zulu', 'mike']);
  });
});

/**
 * What a workspace is CALLED on screen.
 *
 * `Workspace.title` is the display name and `name` is the technical one that
 * `?space=` routes on, so anything the user reads has to prefer the title — the
 * selector showed the name and stayed on it after a title edit, which read as the
 * edit not having taken.
 */
describe('workspaceLabel', () => {
  it('is the title when there is one', () => {
    expect(workspaceLabel({ name: 'q3', title: 'Newsroom Q3' })).toBe('Newsroom Q3');
  });

  it('falls back to the name', () => {
    expect(workspaceLabel({ name: 'q3' })).toBe('q3');
  });

  it('treats a blank title as none, the same way the header does', () => {
    expect(workspaceLabel({ name: 'q3', title: '   ' })).toBe('q3');
  });
});

describe('folderConflicts', () => {
  it('names only the workspaces that exist on both sides', () => {
    expect(folderConflicts(OPEN, FOLDER, 'local.edb')).toEqual([{ id: 'sales', name: 'sales', file: 'sales.edb' }]);
  });

  it('does not call the open file a conflict with itself', () => {
    expect(folderConflicts([{ id: 'sales' }], FOLDER, 'sales.edb')).toEqual([]);
  });

  it('finds nothing when the folder holds different workspaces', () => {
    expect(folderConflicts([{ id: 'scratch' }], [{ id: 'demo', name: 'demo', file: 'demo.edb' }], 'local.edb')).toEqual([]);
  });
});

/**
 * What a brand-new workspace holds, measured on a fresh profile at
 * `?space=SimonProbe` (v0.0.396): no tables and no view instances, but the
 * `views` plugin has already seeded 4 templates and 8 settings rows. So the
 * seeded collections cannot take part in the "is this empty" test — counting
 * them would make every workspace look used.
 */
const JUST_CREATED = { tables: 0, rows: -1, views: 0, templates: 4, settings: 8 };

describe('isEmptyWorkspace', () => {
  it('calls a workspace the URL just created empty', () => {
    expect(isEmptyWorkspace(JUST_CREATED)).toBe(true);
  });

  it('does not call a workspace with a table empty', () => {
    expect(isEmptyWorkspace({ ...JUST_CREATED, tables: 1 })).toBe(false);
  });

  it('does not call a workspace with a view empty', () => {
    // A view with no table of its own is odd but possible, and it is still work
    // the user did.
    expect(isEmptyWorkspace({ ...JUST_CREATED, views: 1 })).toBe(false);
  });

  it('ignores seeded templates and settings on their own', () => {
    expect(isEmptyWorkspace({ tables: 0, rows: -1, views: 0, templates: 99, settings: 99 })).toBe(true);
  });
});

/**
 * Splitting the clashes into the ones worth a prompt and the ones that answer
 * themselves.
 *
 * The scenario that made this necessary: `?space=simon` in a private window
 * CREATES an empty `simon` before any folder is connected (nothing to adopt from
 * at boot), so connecting the folder afterwards found `simon` on both sides and
 * asked which copy was real — with one side an empty shell the app had made
 * itself seconds earlier.
 */
describe('partitionConflicts', () => {
  const SALES: FolderWorkspace = { id: 'sales', name: 'sales', file: 'sales.edb' };
  const SIMON: FolderWorkspace = { id: 'simon', name: 'simon', file: 'simon.edb' };

  it('adopts the file when the local copy is an empty shell', () => {
    expect(partitionConflicts([SIMON], new Set(['simon']))).toEqual({ adopt: [SIMON], ask: [] });
  });

  it('asks when both sides hold something', () => {
    expect(partitionConflicts([SALES], new Set())).toEqual({ adopt: [], ask: [SALES] });
  });

  it('keeps the two apart when a folder holds both kinds', () => {
    expect(partitionConflicts([SALES, SIMON], new Set(['simon']))).toEqual({ adopt: [SIMON], ask: [SALES] });
  });

  it('has nothing to do without conflicts', () => {
    expect(partitionConflicts([], new Set(['simon']))).toEqual({ adopt: [], ask: [] });
  });
});
