import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWorkspaceFileName, workspaceFromArgv, WORKSPACE_EXTENSION } from '../../packages/electron/src/db-files.js';
import { suggestConvertedName } from '../../packages/electron/src/db-convert.js';
import { sourceSizeBytes } from '../../packages/electron/src/db-import.js';

/**
 * `.edb` is a SQLite database carrying our metadata; a plain `.db` is somebody
 * else's data. The distinction is what lets a drag-and-drop ACT instead of
 * asking — `.edb` opens as a workspace, `.db` goes to Import — so the naming
 * rules are load-bearing rather than cosmetic.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'easydb-ws-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isWorkspaceFileName', () => {
  it('accepts .edb, whatever the case', () => {
    expect(isWorkspaceFileName('sales.edb')).toBe(true);
    expect(isWorkspaceFileName('SALES.EDB')).toBe(true);
    expect(isWorkspaceFileName('C:/a b/My Data.edb')).toBe(true);
  });

  it('rejects plain SQLite databases', () => {
    for (const n of ['sales.db', 'sales.sqlite', 'sales.sqlite3', 'northwind.eda.db']) {
      expect(isWorkspaceFileName(n)).toBe(false);
    }
  });

  it('requires the DOT — a name merely ending in the letters is not one', () => {
    // Guards a regex written inside a template literal, where `\.` collapses to
    // "any character" and this passed as a workspace file.
    expect(isWorkspaceFileName('backupedb')).toBe(false);
    expect(isWorkspaceFileName('xedb')).toBe(false);
  });

  it('is the extension the rest of the app builds names from', () => {
    expect(WORKSPACE_EXTENSION).toBe('edb');
    expect(suggestConvertedName('C:/tmp/northwind.db')).toBe('northwind.edb');
    expect(suggestConvertedName('/data/foo.sqlite3')).toBe('foo.edb');
    // Converting something already named .edb must not produce `foo.edb.edb`.
    expect(suggestConvertedName('foo.edb')).toBe('foo.edb');
  });
});

describe('workspaceFromArgv', () => {
  it('finds a .edb argument that exists on disk', () => {
    const file = join(dir, 'sales.edb');
    writeFileSync(file, '');
    // argv[0] is the executable — never a user argument.
    expect(workspaceFromArgv(['electron.exe', file])).toBe(file);
  });

  it('skips the dev-mode "." and any flags', () => {
    const file = join(dir, 'sales.edb');
    writeFileSync(file, '');
    expect(workspaceFromArgv(['electron.exe', '.', '--inspect', file])).toBe(file);
  });

  it('ignores a path that does not exist, rather than opening nothing', () => {
    expect(workspaceFromArgv(['electron.exe', join(dir, 'missing.edb')])).toBeNull();
  });

  it('ignores a plain .db argument — only a workspace can be opened', () => {
    const file = join(dir, 'data.db');
    writeFileSync(file, '');
    expect(workspaceFromArgv(['electron.exe', file])).toBeNull();
  });

  it('is null with no arguments at all', () => {
    expect(workspaceFromArgv(['electron.exe'])).toBeNull();
  });
});

/**
 * The size a convert/import reports so the renderer can decide whether the
 * windows it makes are worth opening. It must never be the thing that fails.
 */
describe('sourceSizeBytes', () => {
  it('reports the file size on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'easydb-size-'));
    try {
      const p = join(dir, 'x.db');
      writeFileSync(p, Buffer.alloc(4096, 7));
      expect(sourceSizeBytes(p)).toBe(4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers 0 for a path that is not there, rather than throwing', () => {
    // A size only picks a default. Failing to stat must not abort an import that
    // would otherwise work — 0 reads as "small", the behaviour that predates it.
    expect(sourceSizeBytes(join(tmpdir(), 'definitely-not-here-9e1f.db'))).toBe(0);
  });
});
