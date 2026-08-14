import { beforeEach, describe, expect, it } from 'vitest';
import { adoptLegacyMarker, fileOf, forgetWorkspace, knownWorkspaces, reconcileRoster, rememberWorkspace } from '../../../packages/renderer/src/db/edb/registry.js';

/**
 * Where each workspace lives.
 *
 * The bug this replaces: one `localStorage` key named "the open .edb", and
 * `localStorage` is per ORIGIN — like IndexedDB — so that one name applied to
 * every workspace and every tab. Moving one workspace into a file therefore hid
 * every other workspace from the selector.
 *
 * So the properties worth testing are about SCOPE: an entry names one workspace,
 * a workspace with no entry is on IndexedDB, and nothing here is global.
 */

const KEY = 'easydb:edb:workspaces';
const LEGACY = 'easydb:edb:active';

/** A localStorage stand-in, since vitest runs these in Node. */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
});

describe('one entry per workspace', () => {
  it('says a workspace with no entry lives in IndexedDB', () => {
    expect(fileOf('scratch')).toBeNull();
    expect(knownWorkspaces()).toEqual([]);
  });

  it('binds one workspace to one file and leaves the others alone', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    expect(fileOf('sales')).toBe('sales.edb');
    // The point of the whole change: naming one workspace says nothing about any
    // other. The old global key answered this with 'sales.edb' too.
    expect(fileOf('scratch')).toBeNull();
  });

  it('holds several workspaces in several files at once', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    rememberWorkspace({ id: 'bible', name: 'Bible', file: 'texts.edb' });
    expect(fileOf('sales')).toBe('sales.edb');
    expect(fileOf('bible')).toBe('texts.edb');
    expect(knownWorkspaces()).toHaveLength(2);
  });

  it('holds two workspaces of ONE file, which is what Open registers', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'company.edb' });
    rememberWorkspace({ id: 'stock', name: 'Stock', file: 'company.edb' });
    expect(knownWorkspaces().map((w) => w.file)).toEqual(['company.edb', 'company.edb']);
  });

  it('carries the name, because the selector must list what it cannot open yet', () => {
    // A load on IndexedDB cannot read a workspace record out of a `.edb`, so the
    // name has to be here or the list has nothing to show.
    rememberWorkspace({ id: 'sales', name: 'Sales Q3', file: 'sales.edb' });
    expect(knownWorkspaces()).toEqual([{ id: 'sales', name: 'Sales Q3', file: 'sales.edb' }]);
  });

  it('lists the IndexedDB workspaces too, which is how a file load names them', () => {
    // A load backed by a `.edb` never opens IndexedDB, so without these entries a
    // browser workspace is exactly as invisible as a file one used to be.
    rememberWorkspace({ id: 'scratch', name: 'Scratch', file: null });
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    expect(knownWorkspaces()).toEqual([
      { id: 'scratch', name: 'Scratch', file: null },
      { id: 'sales', name: 'Sales', file: 'sales.edb' },
    ]);
    expect(fileOf('scratch')).toBeNull();
  });

  it('moves a workspace out of a file and back into IndexedDB', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    rememberWorkspace({ id: 'sales', name: 'Sales', file: null });
    expect(fileOf('sales')).toBeNull();
    expect(JSON.parse(globalThis.localStorage.getItem(KEY)!)).toEqual({ sales: { name: 'Sales' } });
  });

  it('moves a workspace to another file, which is what Save As does', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales-2026.edb' });
    expect(fileOf('sales')).toBe('sales-2026.edb');
    expect(knownWorkspaces()).toHaveLength(1);
  });

  it('forgets one workspace without forgetting the rest', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    rememberWorkspace({ id: 'bible', name: 'Bible', file: 'texts.edb' });
    forgetWorkspace('sales');
    expect(fileOf('sales')).toBeNull();
    expect(fileOf('bible')).toBe('texts.edb');
  });

  it('survives a reload, being what is actually written to storage', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    const raw = globalThis.localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({ sales: { name: 'Sales', file: 'sales.edb' } });
  });

  it('drops the key entirely once the last entry goes', () => {
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    forgetWorkspace('sales');
    expect(globalThis.localStorage.getItem(KEY)).toBeNull();
  });
});

describe('bad stored data', () => {
  it('reads corrupt JSON as no entries rather than throwing at boot', () => {
    // This runs before the store exists, so a throw here is a blank app.
    globalThis.localStorage.setItem(KEY, '{not json');
    expect(knownWorkspaces()).toEqual([]);
    expect(fileOf('sales')).toBeNull();
  });

  it('reads an entry with no file as an IndexedDB workspace, not a broken one', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ sales: { name: 'Sales' }, bible: { name: 'Bible', file: 'texts.edb' } }));
    expect(fileOf('sales')).toBeNull();
    expect(fileOf('bible')).toBe('texts.edb');
    // Both are still LISTED. That is the whole point of holding local workspaces
    // here too: a load backed by a `.edb` never opens IndexedDB, so this is the
    // only place it can learn that "Sales" exists.
    expect(
      knownWorkspaces()
        .map((w) => w.id)
        .sort(),
    ).toEqual(['bible', 'sales']);
  });

  it('refuses a file that is not a usable name', () => {
    // `file` is handed to a worker to open, so an empty string or a number must
    // read as "IndexedDB" rather than reaching it.
    globalThis.localStorage.setItem(KEY, JSON.stringify({ a: { name: 'A', file: '' }, b: { name: 'B', file: 7 } }));
    expect(fileOf('a')).toBeNull();
    expect(fileOf('b')).toBeNull();
  });

  it('falls back to the id when an entry has no name', () => {
    globalThis.localStorage.setItem(KEY, JSON.stringify({ sales: { file: 'sales.edb' } }));
    expect(knownWorkspaces()).toEqual([{ id: 'sales', name: 'sales', file: 'sales.edb' }]);
  });

  it('reads an array as no entries', () => {
    globalThis.localStorage.setItem(KEY, '["sales.edb"]');
    expect(knownWorkspaces()).toEqual([]);
  });
});

describe('reconcileRoster — the two stores must list the same set', () => {
  it('declares every workspace of the store that was opened', () => {
    // The reported symptom: switching between a `.edb` workspace and a local one
    // showed two different lists, because only the resolved workspace was ever
    // recorded. One visit to a store now names everything in it.
    reconcileRoster(
      [
        { id: 'sales', name: 'Sales' },
        { id: 'stock', name: 'Stock' },
        { id: 'bible', name: 'Bible' },
      ],
      null,
    );
    expect(
      knownWorkspaces()
        .map((w) => w.id)
        .sort(),
    ).toEqual(['bible', 'sales', 'stock']);
    expect(fileOf('stock')).toBeNull();
  });

  it('labels the workspaces of a file store with that file', () => {
    reconcileRoster([{ id: 'sales', name: 'Sales' }], 'company.edb');
    expect(fileOf('sales')).toBe('company.edb');
  });

  it('is the union of both stores after each has been opened once', () => {
    reconcileRoster([{ id: 'scratch', name: 'Scratch' }], null);
    reconcileRoster([{ id: 'sales', name: 'Sales' }], 'sales.edb');
    expect(
      knownWorkspaces()
        .map((w) => `${w.id}:${w.file ?? 'local'}`)
        .sort(),
    ).toEqual(['sales:sales.edb', 'scratch:local']);
  });

  it('never relabels a converted workspace, whose IndexedDB copy is still there', () => {
    // Converting COPIES — it does not delete the source (see `edb/convert.ts`), so
    // `sales` is in both stores. A Dexie boot listing it must not claim it as local
    // and strand the file it really opens from.
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    reconcileRoster(
      [
        { id: 'sales', name: 'Sales' },
        { id: 'scratch', name: 'Scratch' },
      ],
      null,
    );
    expect(fileOf('sales')).toBe('sales.edb');
    expect(fileOf('scratch')).toBeNull();
  });

  it('drops an entry of THIS store that the store no longer has', () => {
    // Deleted in another tab. Left in place the selector offers it, and opening it
    // makes boot create an empty workspace under the same name.
    rememberWorkspace({ id: 'gone', name: 'Gone', file: null });
    rememberWorkspace({ id: 'here', name: 'Here', file: null });
    reconcileRoster([{ id: 'here', name: 'Here' }], null);
    expect(knownWorkspaces().map((w) => w.id)).toEqual(['here']);
  });

  it('leaves other stores alone, which it cannot see inside', () => {
    // A Dexie boot knows nothing about what is in `sales.edb`. Pruning on that
    // ignorance would delete the entry that is the only way back to the file.
    rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' });
    rememberWorkspace({ id: 'other', name: 'Other', file: 'other.edb' });
    reconcileRoster([{ id: 'scratch', name: 'Scratch' }], null);
    expect(fileOf('sales')).toBe('sales.edb');
    expect(fileOf('other')).toBe('other.edb');
  });

  it('prunes only within the one file it opened', () => {
    rememberWorkspace({ id: 'a', name: 'A', file: 'one.edb' });
    rememberWorkspace({ id: 'b', name: 'B', file: 'one.edb' });
    rememberWorkspace({ id: 'c', name: 'C', file: 'two.edb' });
    reconcileRoster([{ id: 'a', name: 'A' }], 'one.edb');
    expect(
      knownWorkspaces()
        .map((w) => w.id)
        .sort(),
    ).toEqual(['a', 'c']);
  });

  it('writes nothing when the roster already agrees', () => {
    reconcileRoster([{ id: 'here', name: 'Here' }], null);
    const before = globalThis.localStorage.getItem(KEY);
    reconcileRoster([{ id: 'here', name: 'Here' }], null);
    expect(globalThis.localStorage.getItem(KEY)).toBe(before);
  });
});

describe('taking over the pre-registry marker', () => {
  it('gives the open workspace the file the old key named, once', () => {
    // Without this a user who had a file open would boot into IndexedDB and watch
    // the workspace they were working in disappear — the fault being fixed here.
    globalThis.localStorage.setItem(LEGACY, 'sales.edb');
    expect(adoptLegacyMarker('sales', 'Sales')).toBe('sales.edb');
    expect(fileOf('sales')).toBe('sales.edb');
    // Once only: the marker is gone, so a later workspace does not inherit it.
    expect(globalThis.localStorage.getItem(LEGACY)).toBeNull();
    expect(adoptLegacyMarker('scratch', 'Scratch')).toBeNull();
    expect(fileOf('scratch')).toBeNull();
  });

  it('does nothing when there was no marker', () => {
    expect(adoptLegacyMarker('sales', 'Sales')).toBeNull();
    expect(knownWorkspaces()).toEqual([]);
  });
});

describe('storage that throws', () => {
  it('reads as empty and writes without throwing', () => {
    // Private mode, or storage disabled. The app must still open a workspace.
    (globalThis as { localStorage?: Storage }).localStorage = {
      get length() {
        return 0;
      },
      clear: () => {
        throw new Error('denied');
      },
      getItem: () => {
        throw new Error('denied');
      },
      key: () => null,
      removeItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(knownWorkspaces()).toEqual([]);
    expect(fileOf('sales')).toBeNull();
    expect(() => rememberWorkspace({ id: 'sales', name: 'Sales', file: 'sales.edb' })).not.toThrow();
    expect(() => forgetWorkspace('sales')).not.toThrow();
    expect(adoptLegacyMarker('sales', 'Sales')).toBeNull();
  });
});
