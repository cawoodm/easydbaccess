import { describe, expect, it } from 'vitest';
import type { HostApi, Table } from '@easydb/shared';
import type { EasydbDatabaseFileKind, EasydbDbBridge } from '../db/data-store-ipc.js';
import { openFlow } from './electron-db.js';

/* The fakes in `harness` return settled promises without awaiting anything —
   that is what a stub is. */
/* eslint-disable @typescript-eslint/require-await */

/**
 * The Open… branch. `probeDatabaseFile` (electron side) is unit-tested against
 * real files; what is tested here is what the app DOES with each verdict —
 * specifically that a file we did not write is never opened.
 *
 * Opening one would be destructive in a quiet way: `SqliteStore`'s constructor
 * creates `_easydb_docs`/`_easydb_tables`, so a stranger's database gains two
 * tables and the user is left staring at an empty workspace. So the assertion
 * that matters is `openDbCommit` NOT being called.
 *
 * A fake bridge, not the real app: the OS file dialog can't be scripted, and
 * the `contextBridge` object is frozen, so the picker can't be stubbed in a
 * running Electron either.
 */

interface Recorded {
  alerts: string[];
  choices: Array<{ message: string; options: string[] }>;
  confirms: string[];
  toasts: string[];
  committedOpens: string[];
  importedPaths: Array<string | undefined>;
}

function harness(opts: {
  kind: EasydbDatabaseFileKind;
  path: string;
  /** What the user picks in the foreign-file prompt. */
  choiceAnswer?: string;
  confirmAnswer?: boolean;
}): { api: HostApi; bridge: EasydbDbBridge; rec: Recorded } {
  const rec: Recorded = {
    alerts: [],
    choices: [],
    confirms: [],
    toasts: [],
    committedOpens: [],
    importedPaths: [],
  };

  const bridge = {
    openDb: async () => ({ ok: true as const, path: opts.path, kind: opts.kind }),
    openDbCommit: async (newPath: string) => {
      rec.committedOpens.push(newPath);
      return { ok: true as const, path: newPath };
    },
    saveDbAs: async () => ({ ok: false as const, cancelled: true as const }),
    importDb: async (_workspaceId: string, sourcePath?: string) => {
      rec.importedPaths.push(sourcePath);
      return {
        ok: true as const,
        path: sourcePath ?? opts.path,
        preview: { kind: 'foreign' as const, candidates: [{ name: 'bookmarks', rowCount: 1, collides: false }] },
      };
    },
    importDbCommit: async () => [
      { sourceName: 'bookmarks', finalName: 'bookmarks', action: 'created' as const, tableId: 't1', rowCount: 1 },
    ],
    currentDb: async () => ({ path: opts.path, isDefault: false, fellBackToDefault: false }),
  } as unknown as EasydbDbBridge;

  const api = {
    workspaceId: () => 'ws1',
    store: { tables: { find: async (): Promise<Table[]> => [] } },
    ui: {
      dialogs: {
        alert: async (message: string) => void rec.alerts.push(message),
        choice: async (message: string, options: string[]) => {
          rec.choices.push({ message, options });
          return opts.choiceAnswer ?? null;
        },
        confirm: async (message: string) => {
          rec.confirms.push(message);
          return opts.confirmAnswer ?? false;
        },
        toast: (message: string) => void rec.toasts.push(message),
      },
    },
  } as unknown as HostApi;

  return { api, bridge, rec };
}

describe('electron-db — Open… only opens a database this app wrote', () => {
  it('a file that is not a database at all is reported, and nothing is opened', async () => {
    const { api, bridge, rec } = harness({ kind: 'unreadable', path: 'C:/notes.txt' });
    await openFlow(api, bridge);

    expect(rec.alerts).toHaveLength(1);
    expect(rec.alerts[0]).toContain('C:/notes.txt');
    expect(rec.alerts[0]).toContain('not a SQLite database');
    expect(rec.committedOpens).toEqual([]);
    expect(rec.importedPaths).toEqual([]);
  });

  it('a FOREIGN SQLite file is never opened — it is offered as an import instead', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/places.sqlite',
      choiceAnswer: 'Import its tables',
    });
    await openFlow(api, bridge);

    expect(rec.choices).toHaveLength(1);
    expect(rec.choices[0]!.options).toEqual(['Import its tables', 'Cancel']);
    expect(rec.choices[0]!.message).toContain('not one easyDBAccess wrote');
    // The already-picked path is reused: the user is not asked to find it twice.
    expect(rec.importedPaths).toEqual(['C:/places.sqlite']);
    expect(rec.committedOpens).toEqual([]);
  });

  it('declining the import on a foreign file does nothing at all', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/places.sqlite',
      choiceAnswer: 'Cancel',
    });
    await openFlow(api, bridge);

    expect(rec.importedPaths).toEqual([]);
    expect(rec.committedOpens).toEqual([]);
  });

  it('dismissing the foreign prompt (no choice) also does nothing', async () => {
    const { api, bridge, rec } = harness({ kind: 'foreign', path: 'C:/places.sqlite' });
    await openFlow(api, bridge);

    expect(rec.importedPaths).toEqual([]);
    expect(rec.committedOpens).toEqual([]);
  });

  it('one of our own files still opens, after the usual confirmation', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/work.db',
      confirmAnswer: true,
    });
    await openFlow(api, bridge);

    expect(rec.confirms).toHaveLength(1);
    expect(rec.committedOpens).toEqual(['C:/work.db']);
  });

  it('declining the confirmation leaves the current file active', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/work.db',
      confirmAnswer: false,
    });
    await openFlow(api, bridge);

    expect(rec.committedOpens).toEqual([]);
  });

  it('cancelling the OS picker asks nothing and does nothing', async () => {
    const { api, rec } = harness({ kind: 'easydb', path: 'C:/work.db' });
    const cancelling = {
      openDb: async () => ({ ok: false as const, cancelled: true as const }),
    } as unknown as EasydbDbBridge;
    await openFlow(api, cancelling);

    expect(rec.alerts).toEqual([]);
    expect(rec.choices).toEqual([]);
    expect(rec.confirms).toEqual([]);
    expect(rec.committedOpens).toEqual([]);
  });
});
