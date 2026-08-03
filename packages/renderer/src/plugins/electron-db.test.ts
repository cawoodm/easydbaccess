import { describe, expect, it } from 'vitest';
import type { HostApi, Table } from '@easydb/shared';
import type { EasydbDatabaseFileKind, EasydbDbBridge } from '../db/data-store-ipc.js';
import { openFlow } from './electron-db.js';

/* The fakes in `harness` return settled promises without awaiting anything —
   that is what a stub is. */
/* eslint-disable @typescript-eslint/require-await */

/**
 * What the app does with a `.db`, per verdict of the read-only probe.
 *
 * The invariant worth protecting: a file we did not write is never OPENED.
 * Doing so would be destructive in a quiet way — `SqliteStore`'s constructor
 * creates `_easydb_docs`/`_easydb_tables`, so a stranger's database gains two
 * tables and the user is left staring at an empty workspace over their own
 * data. That is not hypothetical: it happened to a real `northwind.db` (13
 * tables, 17 views) before the guard existed. So the assertion that recurs
 * below is `openDbCommit` NOT being called.
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
  convertedPaths: string[];
  browsedPaths: string[];
  inserted: Array<Record<string, unknown>>;
}

function harness(opts: {
  kind: EasydbDatabaseFileKind;
  path: string;
  /** Answers for successive `choice` prompts, in order. */
  choices?: Array<string | null>;
  confirmAnswer?: boolean;
}): { api: HostApi; bridge: EasydbDbBridge; rec: Recorded } {
  const rec: Recorded = {
    alerts: [],
    choices: [],
    confirms: [],
    toasts: [],
    committedOpens: [],
    importedPaths: [],
    convertedPaths: [],
    browsedPaths: [],
    inserted: [],
  };
  const answers = [...(opts.choices ?? [])];

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
        preview: {
          kind: 'foreign' as const,
          candidates: [{ name: 'bookmarks', rowCount: 1, collides: false }],
        },
      };
    },
    importDbCommit: async () => [
      {
        sourceName: 'bookmarks',
        finalName: 'bookmarks',
        action: 'created' as const,
        tableId: 't1',
        rowCount: 1,
      },
    ],
    convertDb: async (sourcePath: string) => {
      rec.convertedPaths.push(sourcePath);
      return { ok: true as const, path: `${sourcePath}.eda.db`, tables: [] };
    },
    probeDb: async () => opts.kind,
    browseList: async (sourcePath: string) => {
      rec.browsedPaths.push(sourcePath);
      return [
        { name: 'bookmarks', kind: 'table' as const, rowCount: 3, columns: [] },
        { name: 'popular', kind: 'view' as const, rowCount: null, columns: [] },
      ];
    },
    browseRows: async () => [],
    pathForFile: () => '',
    currentDb: async () => ({ path: opts.path, isDefault: false, fellBackToDefault: false }),
  } as unknown as EasydbDbBridge;

  const api = {
    workspaceId: () => 'ws1',
    store: {
      tables: {
        find: async (): Promise<Table[]> => [],
        insert: async (doc: Record<string, unknown>) => {
          rec.inserted.push(doc);
          return doc;
        },
      },
    },
    ui: {
      dialogs: {
        alert: async (message: string) => void rec.alerts.push(message),
        choice: async (message: string, options: string[]) => {
          rec.choices.push({ message, options });
          return answers.length ? (answers.shift() ?? null) : null;
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

describe('electron-db — the one prompt every .db goes through', () => {
  it('offers Open Workspace / Browse / Import data', async () => {
    const { api, bridge, rec } = harness({ kind: 'easydb', path: 'C:/work.db', choices: [null] });
    await openFlow(api, bridge);

    expect(rec.choices[0]!.options).toEqual(['Open Workspace', 'Browse .db file', 'Import data']);
    expect(rec.choices[0]!.message).toContain('C:/work.db');
  });

  it('dismissing that prompt does nothing at all', async () => {
    const { api, bridge, rec } = harness({ kind: 'easydb', path: 'C:/work.db', choices: [null] });
    await openFlow(api, bridge);

    expect(rec.committedOpens).toEqual([]);
    expect(rec.importedPaths).toEqual([]);
    expect(rec.browsedPaths).toEqual([]);
  });

  it('a file that is not a database is reported, and never reaches the prompt', async () => {
    const { api, bridge, rec } = harness({ kind: 'unreadable', path: 'C:/notes.txt' });
    await openFlow(api, bridge);

    expect(rec.alerts[0]).toContain('not a SQLite database');
    expect(rec.choices).toEqual([]);
    expect(rec.committedOpens).toEqual([]);
  });

  it('cancelling the OS picker asks nothing', async () => {
    const { api, rec } = harness({ kind: 'easydb', path: 'C:/work.db' });
    const cancelling = {
      openDb: async () => ({ ok: false as const, cancelled: true as const }),
    } as unknown as EasydbDbBridge;
    await openFlow(api, cancelling);

    expect(rec.choices).toEqual([]);
    expect(rec.alerts).toEqual([]);
    expect(rec.committedOpens).toEqual([]);
  });
});

describe('electron-db — Open Workspace', () => {
  it('opens one of our own files after a confirmation', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/work.db',
      choices: ['Open Workspace'],
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
      choices: ['Open Workspace'],
      confirmAnswer: false,
    });
    await openFlow(api, bridge);

    expect(rec.committedOpens).toEqual([]);
  });

  it('a FOREIGN file is never opened — it offers Convert or Browse', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Open Workspace', 'Convert to EDA'],
    });
    await openFlow(api, bridge);

    expect(rec.choices[1]!.options).toEqual(['Convert to EDA', 'Browse']);
    expect(rec.choices[1]!.message).toContain('not an easyDBAccess workspace');
    expect(rec.convertedPaths).toEqual(['C:/northwind.db']);
    expect(rec.committedOpens).toEqual([]);
  });

  it('choosing Browse from that sub-prompt browses the same file', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Open Workspace', 'Browse', 'All 2'],
    });
    await openFlow(api, bridge);

    expect(rec.browsedPaths).toEqual(['C:/northwind.db']);
    expect(rec.committedOpens).toEqual([]);
  });

  it('dismissing the Convert/Browse sub-prompt does nothing', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Open Workspace', null],
    });
    await openFlow(api, bridge);

    expect(rec.convertedPaths).toEqual([]);
    expect(rec.browsedPaths).toEqual([]);
    expect(rec.committedOpens).toEqual([]);
  });
});

describe('electron-db — Browse', () => {
  it('creates a read-only table per picked object, backed by the sqlitefile source', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Browse .db file', 'All 2'],
    });
    await openFlow(api, bridge);

    expect(rec.inserted).toHaveLength(2);
    for (const doc of rec.inserted) {
      expect(doc.readonly).toBe(true);
      expect((doc.source as { type: string }).type).toBe('sqlitefile');
      expect((doc.source as { writable: boolean }).writable).toBe(false);
    }
    // The view is marked as one, so the source knows it has no rowid.
    const popular = rec.inserted.find((d) => d.name === 'popular')!;
    expect((popular.source as { config: { isView: boolean } }).config.isView).toBe(true);
    expect(rec.committedOpens).toEqual([]);
  });

  it('browses a file we DID write too — Browse does not require a foreign file', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/work.db',
      choices: ['Browse .db file', 'All 2'],
    });
    await openFlow(api, bridge);

    expect(rec.browsedPaths).toEqual(['C:/work.db']);
    expect(rec.inserted).toHaveLength(2);
  });

  it('picking one object browses only that one', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Browse .db file', 'popular (view)'],
    });
    await openFlow(api, bridge);

    expect(rec.inserted).toHaveLength(1);
    expect(rec.inserted[0]!.name).toBe('popular');
  });

  it('dismissing the which-objects prompt creates nothing', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Browse .db file', null],
    });
    await openFlow(api, bridge);

    expect(rec.inserted).toEqual([]);
  });
});

describe('electron-db — Import data', () => {
  it('imports the file already picked, without asking for it again', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      // Only one candidate in the fake preview, so no which-tables prompt.
      choices: ['Import data'],
    });
    await openFlow(api, bridge);

    expect(rec.importedPaths).toEqual(['C:/northwind.db']);
    expect(rec.committedOpens).toEqual([]);
  });
});
