import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ALL_FILES,
  activeFiles,
  activeWorkspaces,
  fileActive,
  folderConflicts,
  isEmptyWorkspace,
  listLabels,
  mergeWorkspaceList,
  overwriteLosesData,
  partitionConflicts,
  readFolderSelection,
  workspaceLabel,
  writeFolderSelection,
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

const OPEN = [{ id: 'scratch' }, { id: 'sales' }];

const FOLDER: FolderWorkspace[] = [
  { id: 'sales', file: 'sales.edb' },
  { id: 'demo', file: 'demo.edb' },
];

describe('mergeWorkspaceList', () => {
  it('lists the open database first, unqualified', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'index.edp');
    expect(merged.slice(0, 2)).toEqual([{ id: 'sales' }, { id: 'scratch' }]);
  });

  it('labels a workspace from another file with that file', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'index.edp');
    expect(merged.filter((e) => e.file !== undefined)).toEqual([
      { id: 'demo', file: 'demo.edb' },
      { id: 'sales', file: 'sales.edb' },
    ]);
  });

  it('shows a clashing name twice, so Cancel leaves both reachable', () => {
    const merged = mergeWorkspaceList(OPEN, FOLDER, 'index.edp');
    expect(merged.filter((e) => e.id === 'sales')).toHaveLength(2);
  });

  it('does not list the open file twice over', () => {
    // Scanning the folder finds the file this tab already has open. Its
    // workspaces are in the open database already, so the entry is dropped.
    const merged = mergeWorkspaceList([{ id: 'sales' }], FOLDER, 'sales.edb');
    expect(merged).toEqual([{ id: 'sales' }, { id: 'demo', file: 'demo.edb' }]);
  });

  it('survives two scans of the same folder without doubling', () => {
    const merged = mergeWorkspaceList([], [...FOLDER, ...FOLDER], 'index.edp');
    expect(merged).toHaveLength(2);
  });

  it('is just the open database when no folder is connected', () => {
    expect(mergeWorkspaceList(OPEN, [], 'index.edp')).toEqual([{ id: 'sales' }, { id: 'scratch' }]);
  });

  it('carries a title through, from the open database and from a file', () => {
    const merged = mergeWorkspaceList([{ id: 'sales', title: 'Sales 2026' }], [{ id: 'demo', title: 'The Demo', file: 'demo.edb' }], 'index.edp');
    expect(merged).toEqual([
      { id: 'sales', title: 'Sales 2026' },
      { id: 'demo', title: 'The Demo', file: 'demo.edb' },
    ]);
  });

  it('sorts by what is shown, not by the technical name', () => {
    // `zulu` is titled "Alpha", so it comes first. Sorting on `name` would put it
    // last and the list would look unsorted to the only person reading it.
    const merged = mergeWorkspaceList([{ id: 'zulu', title: 'Alpha' }, { id: 'mike' }], [], 'index.edp');
    expect(merged.map((e) => e.id)).toEqual(['zulu', 'mike']);
  });
});

/**
 * What a workspace is CALLED on screen.
 *
 * `Workspace.title` is what the user calls it and `id` is the technical one that
 * `?space=` routes on, so anything the user reads has to prefer the title — the
 * selector showed the technical one and stayed on it after a title edit, which
 * read as the edit not having taken.
 */
describe('workspaceLabel', () => {
  it('is the title when there is one', () => {
    expect(workspaceLabel({ id: 'q3', title: 'Newsroom Q3' })).toBe('Newsroom Q3');
  });

  it('falls back to the id, which is also the file name', () => {
    expect(workspaceLabel({ id: 'q3' })).toBe('q3');
  });

  it('treats a blank title as none, the same way the header does', () => {
    expect(workspaceLabel({ id: 'q3', title: '   ' })).toBe('q3');
  });
});

/**
 * Two rows that read the same.
 *
 * The reported bug: `powerplants.edb` held two workspaces, so the selector showed
 * "PowerPlants" twice with the same file in both tooltips — nothing on screen told
 * them apart. Across two FILES that is fine and deliberate, because the tooltip
 * names the file.
 */
describe('listLabels', () => {
  const entry = (id: string, title?: string, file?: string) => ({ id, ...(title === undefined ? {} : { title }), ...(file === undefined ? {} : { file }) });

  it('leaves a label alone when nothing else reads like it', () => {
    expect(listLabels([entry('a', 'Alpha'), entry('b', 'Beta')])).toEqual(['Alpha', 'Beta']);
  });

  it('qualifies two workspaces in one file with the id', () => {
    const labels = listLabels([entry('powerplants', 'PowerPlants'), entry('simon', 'PowerPlants')]);
    expect(labels).toEqual(['PowerPlants (powerplants)', 'PowerPlants (simon)']);
  });

  it('qualifies two entries of the open database, which is one place too', () => {
    expect(listLabels([entry('a', 'Shared'), entry('b', 'Shared')])).toEqual(['Shared (a)', 'Shared (b)']);
  });

  it('leaves one label per file alone — the file tooltip already tells those apart', () => {
    const labels = listLabels([entry('sales', 'Sales'), entry('sales', 'Sales', 'backup.edb')]);
    expect(labels).toEqual(['Sales', 'Sales']);
  });

  it('qualifies by id even when both titles are the same word', () => {
    const labels = listLabels([entry('sales', 'Sales', 'a.edb'), entry('sales-2', 'Sales', 'a.edb')]);
    expect(labels).toEqual(['Sales (sales)', 'Sales (sales-2)']);
  });

  it('does not repeat a title that is already the id', () => {
    // `sales` and `sales` under one roof: the second carries a title that spells
    // its neighbour's id. "sales (sales)" would say nothing twice.
    expect(listLabels([entry('sales'), entry('q3', 'sales')])).toEqual(['sales', 'sales (q3)']);
  });

  it('answers one label per entry, in order, so a caller can index into it', () => {
    const entries = [entry('a', 'X'), entry('b', 'X'), entry('c', 'Y')];
    expect(listLabels(entries)).toHaveLength(entries.length);
  });
});

describe('folderConflicts', () => {
  it('names only the workspaces that exist on both sides', () => {
    expect(folderConflicts(OPEN, FOLDER, 'index.edp')).toEqual([{ file: { id: 'sales', file: 'sales.edb' } }]);
  });

  it('does not call the open file a conflict with itself', () => {
    expect(folderConflicts([{ id: 'sales' }], FOLDER, 'sales.edb')).toEqual([]);
  });

  it('finds nothing when the folder holds different workspaces', () => {
    expect(folderConflicts([{ id: 'scratch' }], [{ id: 'demo', file: 'demo.edb' }], 'index.edp')).toEqual([]);
  });

  it('matches on the ID, which is the only thing a workspace is identified by', () => {
    // This used to match on `name` — a third identifier, minted from the same slug
    // as the id and then free to drift from it — so "the same workspace" had two
    // answers that disagreed the moment anything was renamed. A title carries no
    // weight here at all: two workspaces may share one, and often do.
    const open = [{ id: 'sales' }];
    const folder: FolderWorkspace[] = [{ id: 'sales', title: 'Something else entirely', file: 'sales.edb' }];
    expect(folderConflicts(open, folder, 'index.edp')).toEqual([{ file: folder[0] }]);
  });

  it('does not pair two workspaces that merely share a title', () => {
    const open = [{ id: 'q3-figures' }];
    const folder: FolderWorkspace[] = [{ id: 'sales', title: 'Q3 Figures', file: 'sales.edb' }];
    expect(folderConflicts(open, folder, 'index.edp')).toEqual([]);
  });

  it('ignores case, as the file names do', () => {
    const open = [{ id: 'Sales' }];
    const folder: FolderWorkspace[] = [{ id: 'sales', file: 'sales.edb' }];
    expect(folderConflicts(open, folder, 'index.edp')).toHaveLength(1);
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
  const SALES: FolderClash = { file: { id: 'sales', file: 'sales.edb' } };
  const SIMON: FolderClash = { file: { id: 'simon', file: 'simon.edb' } };

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

/**
 * Which files of the folder this device uses.
 *
 * The rule is small and everything expensive hangs off it — `scanFolder` reads
 * a file only if this says yes — so it is pinned down on its own, away from any
 * directory or worker.
 */
describe('folder file selection', () => {
  const FILES = ['sales.edb', 'demo.edb', 'archive.edb'];

  it('takes everything by default, which is how the folder behaved before this existed', () => {
    expect(activeFiles(FILES, ALL_FILES, 'sales.edb')).toEqual(FILES);
  });

  it('reads only the ticked files once "all" is off', () => {
    const sel = { all: false, files: ['demo.edb'] };
    expect(activeFiles(FILES, sel, '')).toEqual(['demo.edb']);
  });

  it('never switches off the file this tab has open', () => {
    // Its workspace is live — the store, the panels and every plugin are bound
    // to it, so "skip it" is not a state the app can be in.
    const sel = { all: false, files: [] };
    expect(fileActive('sales.edb', sel, 'sales.edb')).toBe(true);
    expect(activeFiles(FILES, sel, 'sales.edb')).toEqual(['sales.edb']);
  });

  it('"all" is a rule, not a snapshot — a file added later is in', () => {
    // This is the whole difference between `all: true` and ticking every box:
    // one keeps working when the folder changes, the other silently does not.
    expect(activeFiles([...FILES, 'new.edb'], ALL_FILES, '')).toContain('new.edb');
    const everyBoxTicked = { all: false, files: FILES };
    expect(activeFiles([...FILES, 'new.edb'], everyBoxTicked, '')).not.toContain('new.edb');
  });

  it('drops indexed workspaces whose file is switched off', () => {
    // Matters for the index written BEFORE a file was switched off: the
    // selector would otherwise keep offering that workspace, and picking it
    // would adopt the very file the user said to leave alone.
    const sel = { all: false, files: ['demo.edb'] };
    expect(activeWorkspaces(FOLDER, sel, '').map((w) => w.file)).toEqual(['demo.edb']);
  });

  it('keeps the open file’s workspaces whatever the selection says', () => {
    const sel = { all: false, files: [] };
    expect(activeWorkspaces(FOLDER, sel, 'sales.edb').map((w) => w.id)).toEqual(['sales']);
  });
});

describe('reading a stored selection', () => {
  const KEY = 'eda:folderFiles';

  // Plain Node has no localStorage, and these tests are about the PARSING —
  // what a value written by another version, or by nothing at all, comes back
  // as. A Map is enough store to ask that question.
  beforeAll(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    });
  });
  afterAll(() => vi.unstubAllGlobals());
  afterEach(() => globalThis.localStorage?.removeItem(KEY));

  it('round-trips', () => {
    writeFolderSelection({ all: false, files: ['a.edb'] });
    expect(readFolderSelection()).toEqual({ all: false, files: ['a.edb'] });
  });

  it('falls back to ALL for anything it cannot read', () => {
    // Never to "nothing": a bad value must not make a user's workspaces vanish.
    for (const bad of ['not json', '{}', '[]', 'null', '{"all":"yes"}']) {
      globalThis.localStorage?.setItem(KEY, bad);
      expect(readFolderSelection()).toEqual(ALL_FILES);
    }
  });

  it('ignores non-string entries rather than trusting the list', () => {
    globalThis.localStorage?.setItem(KEY, JSON.stringify({ all: false, files: ['a.edb', 7, null] }));
    expect(readFolderSelection()).toEqual({ all: false, files: ['a.edb'] });
  });
});
