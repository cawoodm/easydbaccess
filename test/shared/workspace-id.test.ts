import { describe, expect, it } from 'vitest';
import { isCanonicalWorkspaceId, normalizeWorkspaceDoc, slugifyWorkspace, soleWorkspaceOf, spaceFileName, workspaceIdFromFileName } from '../../packages/shared/src/workspace-id.js';

/**
 * The rules that make "the id IS the file name" true.
 *
 * A workspace used to carry three identifiers — `id`, `name` and `title` — with
 * `name` minted from the same slug as the id and then free to drift from it. One
 * workspace could read three ways: the list said "PowerPlants", the file said
 * `powerplants.edb`, and deleting it asked about "Simon".
 */

describe('slugifyWorkspace', () => {
  it('lower-cases, because two ids differing only in case are one file', () => {
    expect(slugifyWorkspace('Power Plants')).toBe('power-plants');
  });

  it('keeps digits, underscores and dashes', () => {
    expect(slugifyWorkspace('q3_2026-final')).toBe('q3_2026-final');
  });

  it('collapses anything else to a single dash and trims the ends', () => {
    expect(slugifyWorkspace('  Sales // 2026!  ')).toBe('sales-2026');
  });

  it('never answers empty, because a workspace with no id has no file', () => {
    expect(slugifyWorkspace('///')).toBe('default');
    expect(slugifyWorkspace('')).toBe('default');
  });
});

describe('isCanonicalWorkspaceId', () => {
  it('accepts an id that is already its own slug', () => {
    expect(isCanonicalWorkspaceId('power-plants')).toBe(true);
  });

  it.each(['My Data', 'Sales', 'q3 2026', ''])('refuses %o, which would not survive a round trip through a file name', (id) => {
    expect(isCanonicalWorkspaceId(id)).toBe(false);
  });

  it('is exactly "slugify changes nothing"', () => {
    // The property the store depends on: anything it accepts maps to a file name
    // and back to itself.
    for (const s of ['sales', 'q3_2026-final', 'default']) {
      expect(workspaceIdFromFileName(spaceFileName(s))).toBe(s);
    }
  });
});

describe('workspaceIdFromFileName', () => {
  it('reads the workspace out of the file name', () => {
    expect(workspaceIdFromFileName('sales.edb')).toBe('sales');
  });

  it('takes the last segment of a path, as an OS dialog hands one back', () => {
    expect(workspaceIdFromFileName('C:\\Users\\marc\\Documents\\sales.edb')).toBe('sales');
    expect(workspaceIdFromFileName('/home/marc/sales.edb')).toBe('sales');
  });

  it('slugifies the stem rather than trusting it', () => {
    // `My Data.edb` answers the id that file WOULD have if this app had written it.
    expect(workspaceIdFromFileName('My Data.edb')).toBe('my-data');
  });
});

describe('soleWorkspaceOf', () => {
  it('names the one workspace a .edb may hold', () => {
    expect(soleWorkspaceOf('powerplants.edb')).toBe('powerplants');
  });

  it('answers null for the project index, which may hold any number', () => {
    expect(soleWorkspaceOf('index.edp')).toBeNull();
  });

  it('answers null for a database with no name at all', () => {
    // A scratch worker opens unnamed databases and the suites drive the store
    // with no file — neither has a file whose name could be an invariant.
    expect(soleWorkspaceOf(null)).toBeNull();
    expect(soleWorkspaceOf(undefined)).toBeNull();
    expect(soleWorkspaceOf('')).toBeNull();
  });

  it('reads through a full path', () => {
    expect(soleWorkspaceOf('/srv/data/sales.edb')).toBe('sales');
  });
});

describe('normalizeWorkspaceDoc', () => {
  it('turns an older file’s name into the title it now serves as', () => {
    expect(normalizeWorkspaceDoc({ id: 'simon', name: 'PowerPlants', createdAt: 1 })).toEqual({ id: 'simon', title: 'PowerPlants', createdAt: 1 });
  });

  it('keeps a real title and drops the name beside it', () => {
    expect(normalizeWorkspaceDoc({ id: 'simon', name: 'simon', title: 'PowerPlants' })).toEqual({ id: 'simon', title: 'PowerPlants' });
  });

  it('leaves a doc with no name alone', () => {
    expect(normalizeWorkspaceDoc({ id: 'sales', createdAt: 2 })).toEqual({ id: 'sales', createdAt: 2 });
  });

  it('does not invent a title out of a blank name', () => {
    // A blank one is no name, the same rule the header applies to a blank title —
    // and a workspace with no title falls back to its id, which is what it had.
    expect(normalizeWorkspaceDoc({ id: 'sales', name: '   ' })).toEqual({ id: 'sales' });
  });

  it('never leaves the name behind, whatever it held', () => {
    expect(normalizeWorkspaceDoc({ id: 'sales', name: 42 })).not.toHaveProperty('name');
  });
});
