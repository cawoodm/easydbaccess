import { describe, expect, it } from 'vitest';
import { alsoWroteNote, withoutTheirOwnFile, writableWholesale } from '../../../packages/renderer/src/db/edb/one-per-file.js';

describe('writableWholesale', () => {
  it('is true for the database that already IS one workspace file', () => {
    expect(writableWholesale(['alpha'])).toBe(true);
  });

  it('is false as soon as a second workspace shares the database', () => {
    expect(writableWholesale(['alpha', 'beta'])).toBe(false);
  });

  it('is true for a database with no workspace record — there is nothing to strip', () => {
    expect(writableWholesale([])).toBe(true);
  });
});

describe('withoutTheirOwnFile', () => {
  it('leaves out the active workspace: the save is writing its file', () => {
    expect(withoutTheirOwnFile(['alpha'], 'alpha', [])).toEqual([]);
  });

  it('names a passenger the folder holds no file for', () => {
    expect(withoutTheirOwnFile(['alpha', 'beta'], 'alpha', ['alpha.edb'])).toEqual(['beta']);
  });

  it('leaves out a passenger that already has its own file', () => {
    expect(withoutTheirOwnFile(['alpha', 'beta'], 'alpha', ['alpha.edb', 'beta.edb'])).toEqual([]);
  });

  it('matches file names case-insensitively — one file to Windows is one file', () => {
    expect(withoutTheirOwnFile(['alpha', 'Beta'], 'alpha', ['BETA.EDB'])).toEqual([]);
  });

  it('ignores files in the folder that are nobody here', () => {
    expect(withoutTheirOwnFile(['alpha', 'beta'], 'alpha', ['northwind.edb'])).toEqual(['beta']);
  });

  it('names every passenger, in the order the database gave them', () => {
    expect(withoutTheirOwnFile(['gamma', 'alpha', 'beta'], 'alpha', [])).toEqual(['gamma', 'beta']);
  });

  it('names a repeated id once', () => {
    expect(withoutTheirOwnFile(['alpha', 'beta', 'beta'], 'alpha', [])).toEqual(['beta']);
  });
});

describe('alsoWroteNote', () => {
  it('says nothing when the save wrote one file, which is the ordinary case', () => {
    expect(alsoWroteNote([])).toBe('');
  });

  it('names one', () => {
    expect(alsoWroteNote(['beta.edb'])).toContain('beta.edb was given a file too');
  });

  it('names a few, with an "and"', () => {
    const note = alsoWroteNote(['beta.edb', 'gamma.edb']);
    expect(note).toContain('beta.edb and gamma.edb were given a file too');
  });

  it('counts rather than lists once the list is longer than the sentence', () => {
    expect(alsoWroteNote(['a.edb', 'b.edb', 'c.edb', 'd.edb', 'e.edb'])).toContain('5 other workspaces');
  });
});
