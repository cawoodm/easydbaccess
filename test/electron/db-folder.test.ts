import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceFileIn, freeWorkspaceFileName, listWorkspaceFiles, peekWorkspaceFile, scanFolderAt } from '../../packages/electron/src/db-folder.js';
import { SqliteStore } from '../../packages/electron/src/sqlite-store.js';

/**
 * The desktop's workspace folder. The browser has read a folder of `.edb` files
 * since v0.0.404; these are the rules the desktop half has to match.
 *
 * The three that carry weight, and each has a test below:
 *
 * 1. Listing a folder must not WRITE to anything in it. A peek opens read-only,
 *    so a folder of ten files stays ten files with no `-wal` beside any of them.
 * 2. A file the device switched off is LISTED but never opened. That is what
 *    makes "switch it off" mean "leave it alone" rather than "hide it".
 * 3. Anything that is not one of our files answers empty rather than throwing.
 *    A folder is not curated, and one bad file must not cost the other nine.
 *
 * `scanWorkspaceFolder` and `createWorkspaceFile` themselves read the remembered
 * folder through Electron's `app.getPath`, which does not exist here — so the
 * suite drives `scanFolderAt` / `createWorkspaceFileIn`, which take the folder
 * as an argument and are what those two call.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-folder-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A real workspace file with `tables` tables in it. */
function makeWorkspace(file: string, id: string, opts: { name?: string; title?: string; tables?: number; views?: number } = {}): void {
  const store = new SqliteStore({ path: join(dir, file) });
  try {
    store.insert('workspaces', { id, name: opts.name ?? id, createdAt: Date.now(), pluginUrls: [], ...(opts.title ? { title: opts.title } : {}) });
    for (let i = 0; i < (opts.tables ?? 0); i++) {
      store.insert('tables', { id: `${id}-t${i}`, workspaceId: id, name: `t${i}`, columns: [{ field: 'a', label: 'A', type: 'string' }], view: 'table', updatedAt: Date.now() });
    }
    for (let i = 0; i < (opts.views ?? 0); i++) {
      store.insert('viewInstances', { id: `${id}-v${i}`, workspaceId: id, tableId: `${id}-t0`, templateId: 'x', name: `v${i}`, open: false, map: {} });
    }
  } finally {
    store.checkpoint();
    store.close();
  }
}

describe('listWorkspaceFiles', () => {
  it('finds .edb files, sorted, and ignores everything else', () => {
    writeFileSync(join(dir, 'beta.edb'), '');
    writeFileSync(join(dir, 'alpha.edb'), '');
    writeFileSync(join(dir, 'notes.txt'), '');
    writeFileSync(join(dir, 'plain.db'), '');
    expect(listWorkspaceFiles(dir)).toEqual(['alpha.edb', 'beta.edb']);
  });

  it('accepts the extension in any case', () => {
    writeFileSync(join(dir, 'SALES.EDB'), '');
    expect(listWorkspaceFiles(dir)).toEqual(['SALES.EDB']);
  });

  it('answers an empty list for a folder that is not there', () => {
    expect(listWorkspaceFiles(join(dir, 'gone'))).toEqual([]);
  });
});

describe('peekWorkspaceFile', () => {
  it('reads the workspaces in a file, with what each holds', () => {
    makeWorkspace('sales.edb', 'sales', { name: 'sales', title: 'Sales', tables: 3, views: 2 });
    const found = peekWorkspaceFile(join(dir, 'sales.edb'));
    expect(found).toEqual([{ id: 'sales', name: 'sales', title: 'Sales', tables: 3, views: 2 }]);
  });

  it('leaves the file byte-identical — the peek opens it read-only', () => {
    makeWorkspace('sales.edb', 'sales', { tables: 1 });
    const before = listWorkspaceFiles(dir);
    peekWorkspaceFile(join(dir, 'sales.edb'));
    // A write would leave `sales.edb-wal` beside it. Nothing new may appear.
    expect(listWorkspaceFiles(dir)).toEqual(before);
  });

  it('answers empty for a file that is not ours, rather than throwing', () => {
    writeFileSync(join(dir, 'junk.edb'), 'this is not a database');
    expect(peekWorkspaceFile(join(dir, 'junk.edb'))).toEqual([]);
  });

  it('answers empty for a plain SQLite database with no format stamp', () => {
    // A foreign file: real SQLite, no `_easydb`. Opening one as a workspace
    // would add our bookkeeping table to somebody else's database.
    const plain = new SqliteStore({ path: join(dir, 'foreign.edb') });
    plain.runSql('CREATE TABLE people (name TEXT)', { write: true });
    plain.runSql(`DELETE FROM _easydb WHERE coll = '_meta'`, { write: true });
    plain.close();
    expect(peekWorkspaceFile(join(dir, 'foreign.edb'))).toEqual([]);
  });

  it('answers empty for a path that does not exist', () => {
    expect(peekWorkspaceFile(join(dir, 'nothing.edb'))).toEqual([]);
  });
});

describe('scanFolderAt', () => {
  it('reports every file with its size and its workspaces', () => {
    makeWorkspace('a.edb', 'a', { tables: 2 });
    makeWorkspace('b.edb', 'b', { tables: 0 });
    const scan = scanFolderAt(dir);
    expect(scan.files.map((f) => f.file)).toEqual(['a.edb', 'b.edb']);
    expect(scan.files[0]!.workspaces).toEqual([{ id: 'a', name: 'a', tables: 2, views: 0 }]);
    expect(scan.files[0]!.size).toBeGreaterThan(0);
    expect(scan.folderPath).toBe(dir);
  });

  it('lists a file the device switched off, but never opens it', () => {
    makeWorkspace('on.edb', 'on', { tables: 1 });
    makeWorkspace('off.edb', 'off', { tables: 9 });
    const scan = scanFolderAt(dir, ['on.edb']);
    // Both named — the Local Data dialog needs the name to offer it back.
    expect(scan.files.map((f) => f.file)).toEqual(['off.edb', 'on.edb']);
    // Only the ticked one was read. The other reports no workspaces at all,
    // which is what "not scanned" looks like to the renderer.
    expect(scan.files.find((f) => f.file === 'off.edb')!.workspaces).toEqual([]);
    expect(scan.files.find((f) => f.file === 'on.edb')!.workspaces).toHaveLength(1);
  });

  it('reads nothing when the selection is empty', () => {
    makeWorkspace('a.edb', 'a', { tables: 1 });
    const scan = scanFolderAt(dir, []);
    expect(scan.files).toHaveLength(1);
    expect(scan.files[0]!.workspaces).toEqual([]);
  });

  it('survives a folder holding one unreadable file', () => {
    makeWorkspace('good.edb', 'good', { tables: 1 });
    writeFileSync(join(dir, 'bad.edb'), 'not a database');
    const scan = scanFolderAt(dir);
    expect(scan.files).toHaveLength(2);
    expect(scan.files.find((f) => f.file === 'good.edb')!.workspaces).toHaveLength(1);
    expect(scan.files.find((f) => f.file === 'bad.edb')!.workspaces).toEqual([]);
  });
});

describe('freeWorkspaceFileName', () => {
  it('uses the plain name when the folder has no such file', () => {
    expect(freeWorkspaceFileName(dir, 'sales')).toBe('sales.edb');
  });

  it('numbers around a name already taken, ignoring case', () => {
    writeFileSync(join(dir, 'Sales.edb'), '');
    expect(freeWorkspaceFileName(dir, 'sales')).toBe('sales (2).edb');
    writeFileSync(join(dir, 'sales (2).edb'), '');
    expect(freeWorkspaceFileName(dir, 'sales')).toBe('sales (3).edb');
  });
});

describe('createWorkspaceFileIn', () => {
  it('writes a file holding exactly one empty workspace', () => {
    const written = createWorkspaceFileIn(dir, 'q3', 'Q3 numbers');
    expect(written).toBe(join(dir, 'q3.edb'));
    expect(peekWorkspaceFile(written)).toEqual([{ id: 'q3', name: 'Q3 numbers', tables: 0, views: 0 }]);
  });

  it('does not overwrite a file already there', () => {
    makeWorkspace('q3.edb', 'q3', { tables: 4 });
    const written = createWorkspaceFileIn(dir, 'q3', 'Q3 numbers');
    expect(written).toBe(join(dir, 'q3 (2).edb'));
    // The original is untouched, tables and all.
    expect(peekWorkspaceFile(join(dir, 'q3.edb'))[0]!.tables).toBe(4);
  });
});
