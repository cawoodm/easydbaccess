import { describe, expect, it } from 'vitest';
import {
  exportUserSettingsBlob,
  hasUserSetting,
  importUserSettingsBlob,
  interpolateSecrets,
  parseSecrets,
  readUserSetting,
  removeUserSetting,
  type StorageLike,
  writeUserSetting,
} from './user-settings.js';

/** In-memory Storage shim so the pure helpers are testable without a DOM. */
function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('user settings blob', () => {
  it('writes, reads, and round-trips values', () => {
    const s = fakeStorage();
    writeUserSetting('server-sync:url', 'http://x', s);
    expect(readUserSetting('server-sync:url', s)).toBe('http://x');
    expect(hasUserSetting('server-sync:url', s)).toBe(true);
    expect(hasUserSetting('missing:key', s)).toBe(false);
  });

  it('removes a key without touching others', () => {
    const s = fakeStorage();
    writeUserSetting('a:x', 1, s);
    writeUserSetting('b:y', 2, s);
    removeUserSetting('a:x', s);
    expect(hasUserSetting('a:x', s)).toBe(false);
    expect(readUserSetting('b:y', s)).toBe(2);
  });

  it('export/import round-trips the whole blob', () => {
    const s1 = fakeStorage();
    writeUserSetting('a:x', 'one', s1);
    writeUserSetting('b:y', 42, s1);
    const blob = exportUserSettingsBlob(s1);

    const s2 = fakeStorage();
    importUserSettingsBlob(blob, s2);
    expect(readUserSetting('a:x', s2)).toBe('one');
    expect(readUserSetting('b:y', s2)).toBe(42);
  });

  it('tolerates corrupt JSON by returning empty', () => {
    const s = fakeStorage();
    s.setItem('/easydbaccess/settings.json', '{not json');
    expect(hasUserSetting('anything', s)).toBe(false);
  });

  it('rejects a non-object import', () => {
    expect(() => importUserSettingsBlob('[1,2,3]', fakeStorage())).toThrow();
  });
});

describe('secrets', () => {
  it('parses key: value lines, ignoring blanks and comments', () => {
    const secrets = parseSecrets('# a comment\ngithubPAT: abc\n\nmypassword: test:123\n');
    expect(secrets).toEqual({ githubPAT: 'abc', mypassword: 'test:123' });
  });

  it('interpolates ${secret:name} and leaves unknowns intact', () => {
    const secrets = { githubPAT: 'abc' };
    expect(interpolateSecrets('token=${secret:githubPAT}', secrets)).toBe('token=abc');
    expect(interpolateSecrets('${secret:missing}', secrets)).toBe('${secret:missing}');
  });
});
