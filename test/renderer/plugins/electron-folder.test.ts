import { describe, expect, it } from 'vitest';
import { baseName, filesToRead, folderSupported, indexFromScan } from '../../../packages/renderer/src/plugins/electron-folder.js';
import type { EasydbDbBridge, EasydbFolderScan } from '../../../packages/renderer/src/db/data-store-bridge.js';

/**
 * The desktop's half of the workspace folder, where it meets the browser's.
 *
 * `indexFromScan` is the whole translation between the two builds: a main-
 * process scan on one side, and on the other the `localStorage` index the
 * workspace selector and the Local Data dialog already read. Every field it
 * drops is one the user then cannot see, so each is asserted here.
 */

const scan = (over: Partial<EasydbFolderScan> = {}): EasydbFolderScan => ({
  folder: 'workspaces',
  folderPath: 'C:/data/workspaces',
  at: 1_700_000_000_000,
  files: [],
  ...over,
});

describe('indexFromScan', () => {
  it('carries the folder name and the scan time', () => {
    const index = indexFromScan(scan());
    expect(index.folder).toBe('workspaces');
    expect(index.at).toBe(1_700_000_000_000);
  });

  it('names every file, including one that was not read', () => {
    const index = indexFromScan(
      scan({
        files: [
          { file: 'a.edb', size: 10, mtime: 1, workspaces: [{ id: 'a', name: 'A', tables: 1, views: 0 }] },
          { file: 'off.edb', size: 20, mtime: 2, workspaces: [] },
        ],
      }),
    );
    // `files` is what the Local Data dialog lists, so a switched-off file has to
    // be in it or there would be no way to switch it back on.
    expect(index.files).toEqual(['a.edb', 'off.edb']);
    expect(index.workspaces.map((w) => w.id)).toEqual(['a']);
  });

  it('gives each workspace its own file, and its file its size and date', () => {
    const index = indexFromScan(
      scan({
        files: [{ file: 'two.edb', size: 4096, mtime: 99, workspaces: [{ id: 'x', name: 'X', tables: 2, views: 1 }] }],
      }),
    );
    expect(index.workspaces).toEqual([{ id: 'x', name: 'X', file: 'two.edb', tables: 2, views: 1, size: 4096, mtime: 99 }]);
  });

  it('keeps a title when there is one and omits the key when there is not', () => {
    const index = indexFromScan(
      scan({
        files: [
          { file: 'a.edb', size: 1, mtime: 1, workspaces: [{ id: 'a', name: 'a', title: 'Sales', tables: 0, views: 0 }] },
          { file: 'b.edb', size: 1, mtime: 1, workspaces: [{ id: 'b', name: 'b', tables: 0, views: 0 }] },
        ],
      }),
    );
    // `workspaceLabel` prefers the title, and `exactOptionalPropertyTypes` means
    // an absent title must be an absent KEY, not an explicit undefined.
    expect(index.workspaces[0]!.title).toBe('Sales');
    expect('title' in index.workspaces[1]!).toBe(false);
  });

  it('flattens a file holding several workspaces', () => {
    // Not a shape this app writes any more — one file, one workspace since
    // v0.0.427 — but an older file can still be in the folder.
    const index = indexFromScan(
      scan({
        files: [
          {
            file: 'old.edb',
            size: 8,
            mtime: 3,
            workspaces: [
              { id: 'one', name: 'One', tables: 1, views: 0 },
              { id: 'two', name: 'Two', tables: 2, views: 0 },
            ],
          },
        ],
      }),
    );
    expect(index.workspaces.map((w) => [w.id, w.file])).toEqual([
      ['one', 'old.edb'],
      ['two', 'old.edb'],
    ]);
  });
});

describe('filesToRead', () => {
  it('asks for everything when the selection says all', () => {
    expect(filesToRead({ all: true, files: [] }, 'open.edb')).toBeUndefined();
    expect(filesToRead({ all: true, files: ['a.edb'] }, null)).toBeUndefined();
  });

  it('asks for the ticked files', () => {
    expect(filesToRead({ all: false, files: ['a.edb', 'b.edb'] }, null)).toEqual(['a.edb', 'b.edb']);
  });

  it('always includes the file this window has open', () => {
    // It cannot be switched off — the dialog shows that row ticked and disabled
    // — so a scan that skipped it would leave the open workspace unlisted.
    expect(filesToRead({ all: false, files: ['a.edb'] }, 'open.edb')).toEqual(['a.edb', 'open.edb']);
  });

  it('does not repeat the open file when it is already ticked', () => {
    expect(filesToRead({ all: false, files: ['open.edb'] }, 'open.edb')).toEqual(['open.edb']);
  });

  it('asks for the open file alone when nothing is ticked', () => {
    expect(filesToRead({ all: false, files: [] }, 'open.edb')).toEqual(['open.edb']);
  });
});

describe('baseName', () => {
  it('takes the file out of a path, either separator', () => {
    expect(baseName('C:\\data\\workspaces\\sales.edb')).toBe('sales.edb');
    expect(baseName('/home/marc/sales.edb')).toBe('sales.edb');
    expect(baseName('sales.edb')).toBe('sales.edb');
  });

  it('answers the whole thing rather than nothing for a trailing separator', () => {
    expect(baseName('C:/data/')).toBe('C:/data/');
  });
});

describe('folderSupported', () => {
  it('is false for a bridge from before the folder IPC existed', () => {
    // A renderer can outlive its preload. Registering the folder UI against an
    // older one would give the user a dialog whose every button throws.
    expect(folderSupported({} as EasydbDbBridge)).toBe(false);
    expect(folderSupported({ scanFolder: () => Promise.resolve(null) } as unknown as EasydbDbBridge)).toBe(false);
  });

  it('is true once both halves are there', () => {
    const bridge = { scanFolder: () => Promise.resolve(null), folderFilePath: () => Promise.resolve(null) } as unknown as EasydbDbBridge;
    expect(folderSupported(bridge)).toBe(true);
  });
});
