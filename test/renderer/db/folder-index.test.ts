import { describe, expect, it } from 'vitest';
import {
  folderConflicts,
  isEmptyWorkspace,
  mergeWorkspaceList,
  overwriteLosesData,
  partitionConflicts,
  workspaceLabel,
  type FolderClash,
  type FolderWorkspace,
} from '../../../packages/renderer/src/db/edb/folder-index.js';

/**
 * Merging the connected folder's workspaces into the list the selector shows.
 *
 * The scenario throughout: this tab has the project index open holding `scratch` and
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
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'index.edp');
    expect(merged.slice(0, 2)).toEqual([
      { id: 'sales', name: 'sales' },
      { id: 'scratch', name: 'scratch' },
    ]);
  });

  it('labels a workspace from another file with that file', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'index.edp');
    expect(merged.filter((e) => e.file !== undefined)).toEqual([
      { id: 'demo', name: 'demo', file: 'demo.edb' },
      { id: 'sales', name: 'sales', file: 'sales.edb' },
    ]);
  });

  it('shows a clashing name twice, so Cancel leaves both reachable', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'index.edp');
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
    const merged = mergeWorkspaceList([], [...FOLDER, ...FOLDER], 'index.edp');
    expect(merged).toHaveLength(2);
  });

  it('is just the open database when no folder is connected', () => {
    expect(mergeWorkspaceList(OPEN, [], 'index.edp')).toEqual([
      { id: 'sales', name: 'sales' },
      { id: 'scratch', name: 'scratch' },
    ]);
  });

  it('carries a title through, from the open database and from a file', () => {
    const merged = mergeWorkspaceList([{ id: 'sales', name: 'sales', title: 'Sales 2026' }], [{ id: 'demo', name: 'demo', title: 'The Demo', file: 'demo.edb' }], 'index.edp');
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
      'index.edp',
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
  it('names only the workspaces that exist on both sides, with both ids', () => {
    expect(folderConflicts(OPEN, FOLDER, 'index.edp')).toEqual([{ file: { id: 'sales', name: 'sales', file: 'sales.edb' }, localId: 'sales' }]);
  });

  it('does not call the open file a conflict with itself', () => {
    expect(folderConflicts([{ id: 'sales', name: 'sales' }], FOLDER, 'sales.edb')).toEqual([]);
  });

  it('finds nothing when the folder holds different workspaces', () => {
    expect(folderConflicts([{ id: 'scratch', name: 'scratch' }], [{ id: 'demo', name: 'demo', file: 'demo.edb' }], 'index.edp')).toEqual([]);
  });

  it('matches on the NAME, so a renamed workspace is still one workspace', () => {
    // The id is a slug of the name at CREATION and never moves again, so after a
    // rename the two disagree — and matching on the id listed one workspace twice.
    const open = [{ id: 'q3-figures', name: 'Sales' }];
    const folder: FolderWorkspace[] = [{ id: 'sales', name: 'Sales', file: 'sales.edb' }];
    expect(folderConflicts(open, folder, 'index.edp')).toEqual([{ file: folder[0], localId: 'q3-figures' }]);
  });

  it('ignores case, as the file names do', () => {
    const open = [{ id: 'sales', name: 'SALES' }];
    const folder: FolderWorkspace[] = [{ id: 'sales', name: 'sales', file: 'sales.edb' }];
    expect(folderConflicts(open, folder, 'index.edp')).toHaveLength(1);
  });

  it('does not match two workspaces that only share an id spelling', () => {
    const open = [{ id: 'sales', name: 'Last year' }];
    const folder: FolderWorkspace[] = [{ id: 'sales', name: 'This year', file: 'sales.edb' }];
    expect(folderConflicts(open, folder, 'index.edp')).toEqual([]);
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
  const SALES: FolderClash = { file: { id: 'sales', name: 'sales', file: 'sales.edb' }, localId: 'sales' };
  const SIMON: FolderClash = { file: { id: 'simon', name: 'simon', file: 'simon.edb' }, localId: 'simon' };

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

/**
 * The second question, asked on top of the choice: an answer that keeps an empty
 * copy over one holding work is almost certainly a slip, and the two buttons of
 * the choice itself cannot say so.
 */
describe('overwriteLosesData', () => {
  it('warns when the copy being kept is empty and the other holds tables', () => {
    expect(overwriteLosesData({ tables: 0, views: 0 }, { tables: 3, views: 0 })).toBe(true);
  });

  it('warns on views alone — a workspace of views is work too', () => {
    expect(overwriteLosesData({ tables: 0, views: 0 }, { tables: 0, views: 2 })).toBe(true);
  });

  it('says nothing when both hold something', () => {
    expect(overwriteLosesData({ tables: 1 }, { tables: 3 })).toBe(false);
  });

  it('says nothing when the copy being dropped is empty too', () => {
    expect(overwriteLosesData({ tables: 0, views: 0 }, { tables: 0, views: 0 })).toBe(false);
  });

  it('says nothing when a count could not be taken', () => {
    // An absent count is not a count of none — the rule `copy-facts.ts` renders
    // by. Inventing a warning here trains the user to click past the real one.
    expect(overwriteLosesData({}, { tables: 3 })).toBe(false);
    expect(overwriteLosesData({ tables: 0, views: 0 }, {})).toBe(false);
  });
});
