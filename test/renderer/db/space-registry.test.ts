import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setEdbBridge } from '../../../packages/renderer/src/db/edb/active-bridge.js';
import type { EdbBridge } from '../../../packages/renderer/src/db/edb/worker-bridge.js';
import { readSpaceRegistry, recordOpenWorkspaces, workspaceList, writeSpaceRegistry } from '../../../packages/renderer/src/db/edb/space-registry.js';
import { FOLDER_INDEX_KEY, FOLDER_SELECTION_KEY, SPACE_REGISTRY_KEY } from '../../../packages/renderer/src/db/edb/device-keys.js';

/**
 * The workspace list, kept where switching workspace cannot change it.
 *
 * The bug, reported twice: half the list came from `store.workspaces.find()` — the
 * database THIS TAB has open — and a tab holds one database. So opening
 * `sales.edb` dropped every workspace living in the project index, and going back
 * brought them all returning. One folder, a different list per workspace.
 *
 * The rule these tests hold down: **nothing on the list comes out of the open
 * database.** What a database holds is RECORDED against that database and read
 * back from the device layer, so switching adds an entry and takes none away.
 */

// Plain Node has no localStorage, and every question here is about what survives a
// round trip through the device layer. A Map is enough store to ask that.
beforeAll(() => {
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  });
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  for (const k of [SPACE_REGISTRY_KEY, FOLDER_INDEX_KEY, FOLDER_SELECTION_KEY]) globalThis.localStorage?.removeItem(k);
  setEdbBridge(null);
});

const browser = () => setEdbBridge({} as EdbBridge);

const folderHolds = (files: string[], workspaces: { id: string; file: string }[]) =>
  globalThis.localStorage?.setItem(FOLDER_INDEX_KEY, JSON.stringify({ folder: 'workspaces', at: 1, files, workspaces }));

describe('the registry', () => {
  it('round-trips, keyed by database name', () => {
    writeSpaceRegistry({ 'index.edp': [{ id: 'scratch' }], 'sales.edb': [{ id: 'sales', title: 'Sales 2026' }] });
    expect(readSpaceRegistry()).toEqual({ 'index.edp': [{ id: 'scratch' }], 'sales.edb': [{ id: 'sales', title: 'Sales 2026' }] });
  });

  it('reads back as nothing when there is nothing, or nothing legible', () => {
    // Never a throw: this is a cache, and a value from another version costs the
    // entries the folder cannot also name — not the app.
    expect(readSpaceRegistry()).toEqual({});
    for (const bad of ['not json', '[]', 'null', '7']) {
      globalThis.localStorage?.setItem(SPACE_REGISTRY_KEY, bad);
      expect(readSpaceRegistry()).toEqual({});
    }
  });

  it('drops entries with no id rather than trusting the list', () => {
    globalThis.localStorage?.setItem(SPACE_REGISTRY_KEY, JSON.stringify({ 'index.edp': [{ id: 'a' }, { title: 'no id' }, null, 7], bad: 'not a list' }));
    expect(readSpaceRegistry()).toEqual({ 'index.edp': [{ id: 'a' }] });
  });

  it('records each database against its own name, leaving the others alone', () => {
    browser();
    recordOpenWorkspaces('index.edp', [{ id: 'scratch' }]);
    recordOpenWorkspaces('sales.edb', [{ id: 'sales' }]);
    expect(readSpaceRegistry()).toEqual({ 'index.edp': [{ id: 'scratch' }], 'sales.edb': [{ id: 'sales' }] });
  });

  it('records nothing for the project index inside Electron', () => {
    // With no folder connected the desktop's `activeEdbName()` answers `index.edp`
    // for want of a browser session marker, so the name alone is not enough. No
    // bridge means Electron — the same test `space-adopt.ts` makes.
    setEdbBridge(null);
    writeSpaceRegistry({ 'index.edp': [{ id: 'scratch' }] });
    recordOpenWorkspaces('index.edp', [{ id: 'a-desktop-workspace' }]);
    expect(readSpaceRegistry()).toEqual({ 'index.edp': [{ id: 'scratch' }] });
  });

  it('forgets a `.edb` the folder no longer has', () => {
    browser();
    writeSpaceRegistry({ 'gone.edb': [{ id: 'gone' }], 'sales.edb': [{ id: 'sales' }], 'index.edp': [{ id: 'scratch' }] });
    folderHolds(['sales.edb'], [{ id: 'sales', file: 'sales.edb' }]);
    recordOpenWorkspaces('sales.edb', [{ id: 'sales' }]);
    // The project index is never pruned — the folder has nothing to say about it.
    expect(Object.keys(readSpaceRegistry()).sort()).toEqual(['index.edp', 'sales.edb']);
  });

  it('prunes nothing against a scan that never listed the files', () => {
    // An index from before `files` existed proves nothing about what is missing,
    // and guessing there would take a real workspace off the list.
    browser();
    writeSpaceRegistry({ 'gone.edb': [{ id: 'gone' }] });
    globalThis.localStorage?.setItem(FOLDER_INDEX_KEY, JSON.stringify({ folder: 'w', at: 1, workspaces: [] }));
    recordOpenWorkspaces('index.edp', [{ id: 'scratch' }]);
    expect(Object.keys(readSpaceRegistry()).sort()).toEqual(['gone.edb', 'index.edp']);
  });

});

describe('workspaceList', () => {
  it('is the SAME list whichever database the tab has open', () => {
    // The report, and the one invariant that matters.
    folderHolds(['sales.edb', 'demo.edb'], [
      { id: 'sales', file: 'sales.edb' },
      { id: 'demo', file: 'demo.edb' },
    ]);
    writeSpaceRegistry({ 'index.edp': [{ id: 'scratch' }], 'sales.edb': [{ id: 'sales' }] });

    const fromIndex = workspaceList('index.edp');
    const fromSales = workspaceList('sales.edb');
    const fromDemo = workspaceList('demo.edb');

    expect(fromIndex).toEqual(fromSales);
    expect(fromSales).toEqual(fromDemo);
    expect(fromIndex.map((e) => e.id)).toEqual(['demo', 'sales', 'scratch']);
  });

  it('carries the file for a workspace that lives in one', () => {
    folderHolds(['sales.edb'], [{ id: 'sales', file: 'sales.edb' }]);
    expect(workspaceList('sales.edb')).toEqual([{ id: 'sales', file: 'sales.edb' }]);
  });

  it('lists one row per id', () => {
    folderHolds(['sales.edb'], [{ id: 'sales', file: 'sales.edb' }]);
    writeSpaceRegistry({ 'index.edp': [{ id: 'sales' }], 'sales.edb': [{ id: 'sales' }] });
    expect(workspaceList('index.edp')).toEqual([{ id: 'sales', file: 'sales.edb' }]);
  });

  it('lists a workspace recorded in BOTH with the file that holds it', () => {
    // One workspace is in both for a while by design: the first Save copies it out
    // of the project index into its own `.edb` and adopts that file with no
    // reload, and the index's copy is not deleted. Left in insertion order the
    // index's entry could win, and the list would call a workspace that has just
    // been written to disk "stored in this browser" — while the Save toast quotes
    // the file name.
    writeSpaceRegistry({ 'index.edp': [{ id: 'sales' }], 'sales.edb': [{ id: 'sales' }] });
    expect(workspaceList('sales.edb')).toEqual([{ id: 'sales', file: 'sales.edb' }]);
  });

  it('answers from the registry alone when no folder has been scanned', () => {
    writeSpaceRegistry({ 'index.edp': [{ id: 'scratch' }], 'elsewhere.edb': [{ id: 'elsewhere' }] });
    expect(workspaceList('index.edp')).toEqual([{ id: 'elsewhere', file: 'elsewhere.edb' }, { id: 'scratch' }]);
  });

  it('leaves out a file this device switched off, wherever the entry came from', () => {
    folderHolds(['demo.edb', 'sales.edb'], [{ id: 'demo', file: 'demo.edb' }]);
    writeSpaceRegistry({ 'demo.edb': [{ id: 'demo' }], 'sales.edb': [{ id: 'sales' }] });
    globalThis.localStorage?.setItem(FOLDER_SELECTION_KEY, JSON.stringify({ all: false, files: [] }));
    // The file this tab has OPEN is never switched off, whatever the selection says.
    expect(workspaceList('sales.edb')).toEqual([{ id: 'sales', file: 'sales.edb' }]);
  });
});
