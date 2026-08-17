import { describe, expect, it } from 'vitest';
import { folderConflicts, mergeWorkspaceList, type FolderWorkspace } from '../../../packages/renderer/src/db/edb/folder-index.js';

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
