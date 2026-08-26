import { describe, expect, it } from 'vitest';
import { afterRename, fileIdentities, misfiledFiles, withoutFiles } from '../../../packages/renderer/src/db/edb/file-identity.js';
import type { FolderWorkspace } from '../../../packages/renderer/src/db/edb/folder-index.js';

/** One scanned workspace. Only the fields the rule reads have to be real. */
function found(file: string, id: string, extra: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return { id, name: id, file, ...extra };
}

describe('fileIdentities', () => {
  it('says nothing about a file that holds the workspace its name names', () => {
    expect(fileIdentities([found('sales.edb', 'sales')])[0]).toMatchObject({ file: 'sales.edb', claimed: 'sales', fix: 'matches' });
  });

  it('asks to rename a workspace whose id is not what the file name says', () => {
    expect(fileIdentities([found('b.edb', 'a')])[0]).toMatchObject({ file: 'b.edb', id: 'a', claimed: 'b', fix: 'rename' });
  });

  it('picks out the second file when two hold the same workspace id — the reported bug', () => {
    // `a.edb` and `b.edb` both hold the workspace `a`. Only one file can be the
    // workspace `a`, and it is the one named after it.
    const identities = fileIdentities([found('a.edb', 'a'), found('b.edb', 'a')]);
    expect(identities.map((i) => [i.file, i.fix])).toEqual([
      ['a.edb', 'matches'],
      ['b.edb', 'rename'],
    ]);
  });

  it('matches a file name that is not a slug already', () => {
    // `My Data.edb` is the workspace `my-data`, the same id New workspace would
    // have given it — so this file is right and asks nothing.
    expect(fileIdentities([found('My Data.edb', 'my-data')])[0]?.fix).toBe('matches');
  });

  it('leaves a file holding several workspaces alone — that is a different broken shape', () => {
    // Written before v0.0.427, when Save wrote the whole database into one file.
    // `one-per-file.ts` owns it, and no rename would make the file right.
    expect(fileIdentities([found('a.edb', 'a'), found('a.edb', 'b')])).toEqual([]);
  });

  it('carries the file date and size through, so the question can show them', () => {
    expect(fileIdentities([found('b.edb', 'a', { mtime: 1_700_000_000_000, size: 4096 })])[0]).toMatchObject({ mtime: 1_700_000_000_000, size: 4096 });
  });

  it('leaves the date out rather than inventing one when the scan could not read it', () => {
    expect(fileIdentities([found('b.edb', 'a')])[0]).not.toHaveProperty('mtime');
  });

  describe('two file names claiming one id', () => {
    it('prefers the file this app would itself have written, and sets the other aside', () => {
      // Both names slugify to `my-data`, so renaming either lands on the id the
      // other one already has. `my-data.edb` is the name Save produces.
      const identities = fileIdentities([found('my-data.edb', 'my-data'), found('My Data.edb', 'my-data')]);
      expect(identities.map((i) => [i.file, i.fix])).toEqual([
        ['my-data.edb', 'matches'],
        ['My Data.edb', 'ambiguous'],
      ]);
      expect(identities[1]?.rivals).toEqual(['my-data.edb']);
    });

    it('sets both aside when neither carries the name this app writes', () => {
      const identities = fileIdentities([found('My Data.edb', 'my-data'), found('My  Data.edb', 'other')]);
      expect(identities.every((i) => i.fix === 'ambiguous')).toBe(true);
      expect(identities[0]?.rivals).toEqual(['My  Data.edb']);
    });

    it('still asks to rename the preferred file when its own contents are wrong', () => {
      // `my-data.edb` holds `sales`: it is the canonical name for `my-data`, so it
      // is not the ambiguous one — it is simply misfiled, and renamable.
      const identities = fileIdentities([found('my-data.edb', 'sales'), found('My Data.edb', 'my-data')]);
      expect(identities.map((i) => [i.file, i.fix])).toEqual([
        ['my-data.edb', 'rename'],
        ['My Data.edb', 'ambiguous'],
      ]);
    });
  });
});

describe('misfiledFiles', () => {
  it('is only the files that need an answer', () => {
    expect(misfiledFiles([found('a.edb', 'a'), found('b.edb', 'a'), found('c.edb', 'c')]).map((i) => i.file)).toEqual(['b.edb']);
  });

  it('is empty for a folder every file of which is named after what it holds', () => {
    expect(misfiledFiles([found('a.edb', 'a'), found('b.edb', 'b')])).toEqual([]);
  });
});

describe('withoutFiles', () => {
  it('drops every workspace found in the named files and keeps the rest', () => {
    expect(withoutFiles([found('a.edb', 'a'), found('b.edb', 'a')], ['b.edb']).map((w) => w.file)).toEqual(['a.edb']);
  });

  it('matches case-insensitively — one file to Windows is one file', () => {
    expect(withoutFiles([found('B.edb', 'a')], ['b.edb'])).toEqual([]);
  });

  it('changes nothing when there is nothing to drop', () => {
    const scan = [found('a.edb', 'a')];
    expect(withoutFiles(scan, [])).toEqual(scan);
  });
});

describe('afterRename', () => {
  it('moves the id AND the name, because a clash is matched on the name', () => {
    expect(afterRename([found('b.edb', 'a')], 'b.edb', 'b')[0]).toMatchObject({ id: 'b', name: 'b' });
  });

  it('leaves every other file alone', () => {
    expect(afterRename([found('a.edb', 'a'), found('b.edb', 'a')], 'b.edb', 'b').map((w) => `${w.file}:${w.id}`)).toEqual(['a.edb:a', 'b.edb:b']);
  });

  it('keeps what the scan learned about the file', () => {
    expect(afterRename([found('b.edb', 'a', { tables: 3, mtime: 7 })], 'b.edb', 'b')[0]).toMatchObject({ tables: 3, mtime: 7 });
  });
});
