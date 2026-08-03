import { describe, expect, it } from 'vitest';
import type { HostApi, Table } from '@easydb/shared';
import type { EasydbDatabaseFileKind, EasydbDbBridge } from '../../../packages/renderer/src/db/data-store-ipc.js';
import { handleDroppedFile, openFlow, resumePendingImport } from '../../../packages/renderer/src/plugins/electron-db.js';

/* The fakes in `harness` return settled promises without awaiting anything —
   that is what a stub is. */
/* eslint-disable require-await */

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
  /** The object names each convert was narrowed to (`null` = the whole file). */
  convertedNames: Array<string[] | null>;
  preparedPaths: string[];
  importedTableIds: string[];
  browsedPaths: string[];
  inserted: Array<Record<string, unknown>>;
  settingsRemoved: string[];
}

/** Must match `PENDING_IMPORT_SETTING` in the plugin. */
const PENDING = 'electron-db:pendingImport';

/** A pending-import note, as `prepareConvert` leaves it in a converted file. */
function note(tables: number, total = 100): { sourcePath: string; plan: unknown[] } {
  return {
    sourcePath: 'C:/northwind.db',
    plan: Array.from({ length: tables }, (_, i) => ({
      sourceName: `t${i}`,
      finalName: `t${i}`,
      tableId: `id${i}`,
      sqlTable: `t${i}`,
      total,
      kind: 'foreign' as const,
      action: 'created' as const,
    })),
  };
}

function harness(opts: {
  kind: EasydbDatabaseFileKind;
  path: string;
  /** Answers for successive `choice` prompts, in order. */
  choices?: Array<string | null>;
  confirmAnswer?: boolean;
  /** An unfinished conversion's note, if this workspace has one. */
  pending?: { sourcePath: string; plan: unknown[] };
  /** Make the single candidate collide with an existing table. */
  collides?: boolean;
  /** The source table's column names. */
  sourceColumns?: string[];
  /** The existing table an append would target. */
  existingTable?: { name: string; columns: Array<{ field: string; label: string; type: string }> };
}): { api: HostApi; bridge: EasydbDbBridge; rec: Recorded } {
  const rec: Recorded = {
    alerts: [],
    choices: [],
    confirms: [],
    toasts: [],
    committedOpens: [],
    importedPaths: [],
    convertedPaths: [],
    convertedNames: [],
    preparedPaths: [],
    importedTableIds: [],
    browsedPaths: [],
    inserted: [],
    settingsRemoved: [],
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
          candidates: [{ name: 'bookmarks', rowCount: 1, collides: opts.collides ?? false, columns: opts.sourceColumns ?? ['url', 'title'] }],
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
    convertDb: async (sourcePath: string, only?: string[]) => {
      rec.convertedPaths.push(sourcePath);
      rec.convertedNames.push(only ?? null);
      return { ok: true as const, path: `${sourcePath}.eda.db`, tables: [] };
    },
    probeDb: async () => opts.kind,
    importPrepare: async (sourcePath: string) => {
      rec.preparedPaths.push(sourcePath);
      return {
        plan: [
          {
            sourceName: 'bookmarks',
            finalName: 'bookmarks',
            tableId: 't1',
            sqlTable: 'bookmarks',
            total: 1,
            kind: 'foreign' as const,
            action: 'created' as const,
          },
        ],
        skipped: [],
      };
    },
    importRows: async (_sourcePath: string, entry: { tableId: string; total: number }) => {
      rec.importedTableIds.push(entry.tableId);
      return entry.total;
    },
    onImportProgress: () => () => undefined,
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
        find: async (): Promise<Table[]> =>
          opts.existingTable ? [{ id: 'existing', workspaceId: 'ws1', name: opts.existingTable.name, columns: opts.existingTable.columns, view: 'table', updatedAt: 1 } as unknown as Table] : [],
        insert: async (doc: Record<string, unknown>) => {
          rec.inserted.push(doc);
          return doc;
        },
      },
      settings: {
        findOne: async (name: string) => (name === PENDING && opts.pending ? { name, value: opts.pending } : null),
        remove: async (name: string) => void rec.settingsRemoved.push(name),
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
      choices: ['Open Workspace', 'Convert to EDA', 'All 2'],
    });
    await openFlow(api, bridge);

    expect(rec.choices[1]!.options).toEqual(['Convert to EDA', 'Browse']);
    expect(rec.choices[1]!.message).toContain('not an easyDBAccess workspace');
    expect(rec.convertedPaths).toEqual(['C:/northwind.db']);
    expect(rec.committedOpens).toEqual([]);
  });

  it('Convert asks which objects first, and converts only those', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Open Workspace', 'Convert to EDA', 'bookmarks — 3 rows'],
    });
    await openFlow(api, bridge);

    expect(rec.choices[2]!.message).toContain('Which tables or views');
    // The tables-without-the-views shortcut is offered here (Browse doesn't get it).
    expect(rec.choices[2]!.options).toContain('All 1 table (skip the views)');
    expect(rec.convertedNames).toEqual([['bookmarks']]);
  });

  it('Convert can skip the views in one step', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Open Workspace', 'Convert to EDA', 'All 1 table (skip the views)'],
    });
    await openFlow(api, bridge);

    expect(rec.convertedNames).toEqual([['bookmarks']]);
  });

  it('dismissing the which-objects prompt converts nothing', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Open Workspace', 'Convert to EDA', null],
    });
    await openFlow(api, bridge);

    expect(rec.convertedPaths).toEqual([]);
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

  it('creates the structure first, then fills it — the file is only picked once', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      choices: ['Import data'],
    });
    await openFlow(api, bridge);

    // Phase 1 runs on the already-picked path, phase 2 fills what it created.
    expect(rec.preparedPaths).toEqual(['C:/northwind.db']);
    expect(rec.importedTableIds).toEqual(['t1']);
  });
});

/**
 * An interrupted conversion leaves a note naming the rows it still owes. Acting
 * on it WITHOUT asking made the app unusable: any conversion that didn't finish
 * — window closed, app crashed — meant every subsequent launch immediately began
 * a minutes-long import, unprompted and unstoppable. Recovering from an
 * interruption must not be something the user cannot get out of.
 */
describe('electron-db — an unfinished import', () => {
  it('never starts copying without asking', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/converted.db',
      pending: note(13),
      choices: [null], // the prompt is dismissed
    });
    await resumePendingImport(api, bridge);

    expect(rec.choices).toHaveLength(1);
    expect(rec.importedTableIds).toEqual([]);
  });

  it('says how much is left, and that it can be stopped', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/converted.db',
      pending: note(2, 1000),
      choices: [null],
    });
    await resumePendingImport(api, bridge);

    expect(rec.choices[0]!.message).toContain('C:/northwind.db');
    expect(rec.choices[0]!.message).toContain((2000).toLocaleString());
    expect(rec.choices[0]!.message).toMatch(/stopped/i);
  });

  it('fills the tables in when asked to', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/converted.db',
      pending: note(3),
      choices: ['Fill them in now'],
    });
    await resumePendingImport(api, bridge);

    expect(rec.importedTableIds).toEqual(['id0', 'id1', 'id2']);
    expect(rec.settingsRemoved).toEqual([PENDING]); // the note is done with
  });

  it('discarding drops the note, so the offer does not come back', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/converted.db',
      pending: note(3),
      choices: ['Leave them empty'],
    });
    await resumePendingImport(api, bridge);

    expect(rec.importedTableIds).toEqual([]);
    expect(rec.settingsRemoved).toEqual([PENDING]);
  });

  it('a dismissed prompt keeps the note, so it can be offered again', async () => {
    const { api, bridge, rec } = harness({
      kind: 'easydb',
      path: 'C:/converted.db',
      pending: note(3),
      choices: [null],
    });
    await resumePendingImport(api, bridge);

    expect(rec.settingsRemoved).toEqual([]);
  });

  it('does nothing at all when there is no note', async () => {
    const { api, bridge, rec } = harness({ kind: 'easydb', path: 'C:/plain.db' });
    await resumePendingImport(api, bridge);

    expect(rec.choices).toEqual([]);
    expect(rec.importedTableIds).toEqual([]);
  });
});

/**
 * A dropped file's EXTENSION decides what happens, with no question asked: `.edb`
 * carries our metadata and opens as a workspace, anything else is somebody else's
 * data and goes to Import. The three-way prompt this replaced was asked on every
 * drop, when the answer was already implied by which file the user reached for.
 */
describe('electron-db — a dropped file routes by extension', () => {
  it('a .edb opens as a workspace, asking only to confirm', async () => {
    const { api, bridge, rec } = harness({ kind: 'easydb', path: 'C:/sales.edb', confirmAnswer: true });
    await handleDroppedFile(api, bridge, 'C:/sales.edb', true);

    // No "what would you like to do" — straight to the Open confirmation.
    expect(rec.choices).toEqual([]);
    expect(rec.confirms).toHaveLength(1);
    expect(rec.committedOpens).toEqual(['C:/sales.edb']);
  });

  it('declining that confirmation opens nothing', async () => {
    const { api, bridge, rec } = harness({ kind: 'easydb', path: 'C:/sales.edb', confirmAnswer: false });
    await handleDroppedFile(api, bridge, 'C:/sales.edb', true);

    expect(rec.committedOpens).toEqual([]);
  });

  it('a plain .db goes straight to Import, with no prompt about what to do', async () => {
    const { api, bridge, rec } = harness({ kind: 'foreign', path: 'C:/northwind.db' });
    await handleDroppedFile(api, bridge, 'C:/northwind.db', false);

    // Only the which-objects picker, never the three-way question.
    expect(rec.choices.every((c) => !c.options.includes('Open Workspace'))).toBe(true);
    expect(rec.importedPaths).toEqual(['C:/northwind.db']);
    expect(rec.committedOpens).toEqual([]);
  });

  it('a .edb that is NOT one is never opened — it says so and offers what it can', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/mislabelled.edb',
      choices: [null], // dismiss the fallback offer
    });
    await handleDroppedFile(api, bridge, 'C:/mislabelled.edb', true);

    // Opening it would add our bookkeeping tables to someone else's file.
    expect(rec.committedOpens).toEqual([]);
    expect(rec.toasts.some((t) => /does not contain one/.test(t))).toBe(true);
    expect(rec.choices[0]!.options).toEqual(['Open Workspace', 'Browse .db file', 'Import data']);
  });
});

/**
 * Append adds rows to an existing table and leaves its schema alone. Whether the
 * user is asked for a column mapping depends on whether the names already line
 * up — asking when there is nothing to decide is noise, and NOT asking when they
 * differ is how values land in the wrong fields.
 */
describe('electron-db — Append onto an existing table', () => {
  it('offers Append first among the collision choices', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      collides: true,
      choices: ['Import data', null],
    });
    await openFlow(api, bridge);

    const collision = rec.choices.find((c) => c.message.includes('already exists'));
    expect(collision?.options).toEqual(['Append', 'Overwrite', 'Rename', 'Skip']);
  });

  it('does not ask for a mapping when every source column already matches', async () => {
    const { api, bridge, rec } = harness({
      kind: 'foreign',
      path: 'C:/northwind.db',
      collides: true,
      sourceColumns: ['url', 'title'],
      existingTable: {
        name: 'bookmarks',
        columns: [
          { field: 'url', label: 'URL', type: 'text' },
          { field: 'title', label: 'Title', type: 'text' },
        ],
      },
      choices: ['Import data', 'Append'],
    });
    await openFlow(api, bridge);

    // The mapper is a separate dialog; only the two choice prompts should appear.
    expect(rec.choices).toHaveLength(2);
    expect(rec.preparedPaths).toEqual(['C:/northwind.db']);
  });
});
