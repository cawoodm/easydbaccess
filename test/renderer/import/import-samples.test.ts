import { describe, expect, it } from 'vitest';
import {
  addUserSample,
  hideSample,
  parseHiddenSamples,
  parseUserSamples,
  removeUserSample,
  sampleEntries,
  type ImportSample,
  type UserImportSample,
} from '../../../packages/renderer/src/import/import-samples.js';

const SHIPPED: ImportSample[] = [
  { label: 'Northwind', url: 'https://x/northwind.db.json', kind: 'json' },
  { label: 'Air quality', url: 'https://x/air.csv', kind: 'csv' },
];

const mine = (over: Partial<UserImportSample> = {}): UserImportSample => ({ id: 'u1', label: 'My data', url: 'https://mine/a.csv', kind: 'csv', ...over });

describe('sampleEntries', () => {
  it('shows what we ship, then what the user added', () => {
    const list = sampleEntries(SHIPPED, [mine()], []);
    expect(list.map((s) => s.label)).toEqual(['Northwind', 'Air quality', 'My data']);
    expect(list.map((s) => s.own)).toEqual([false, false, true]);
  });

  it('drops a shipped sample the user deleted', () => {
    const list = sampleEntries(SHIPPED, [], ['https://x/air.csv']);
    expect(list.map((s) => s.label)).toEqual(['Northwind']);
  });

  it('keys a shipped sample by url and the user’s by id, so a delete knows which is which', () => {
    const list = sampleEntries(SHIPPED, [mine()], []);
    expect(list[0]!.key).toBe('b:https://x/northwind.db.json');
    expect(list[2]!.key).toBe('u:u1');
  });

  // Hiding by url means a url we later change stops matching — the sample comes
  // back rather than the deletion silently applying to something else.
  it('a hidden url that no longer exists hides nothing', () => {
    const list = sampleEntries(SHIPPED, [], ['https://x/gone.csv']);
    expect(list).toHaveLength(2);
  });
});

describe('parseUserSamples', () => {
  it('reads a JSON string as well as an array — the store may hold either', () => {
    const one = [{ id: 'a', label: 'A', url: 'https://a', kind: 'csv' }];
    expect(parseUserSamples(one)).toEqual(one);
    expect(parseUserSamples(JSON.stringify(one))).toEqual(one);
  });

  it('drops an entry with no id, label or url', () => {
    const raw = [
      { label: 'A', url: 'https://a' },
      { id: 'b', url: 'https://b' },
      { id: 'c', label: ' ', url: 'https://c' },
      { id: 'd', label: 'D' },
      { id: 'e', label: 'E', url: 'https://e' },
    ];
    expect(parseUserSamples(raw).map((s) => s.id)).toEqual(['e']);
  });

  it('keeps a sample whose kind is unreadable, and lets the URL be auto-detected', () => {
    const [s] = parseUserSamples([{ id: 'a', label: 'A', url: 'https://a', kind: 'xml' }]);
    expect(s).toEqual({ id: 'a', label: 'A', url: 'https://a' });
  });

  it('survives rubbish', () => {
    expect(parseUserSamples(undefined)).toEqual([]);
    expect(parseUserSamples('not json')).toEqual([]);
    expect(parseUserSamples({ nope: 1 })).toEqual([]);
    expect(parseUserSamples([null, 3, 'x'])).toEqual([]);
  });
});

describe('parseHiddenSamples', () => {
  it('reads a list of urls, from a string or an array', () => {
    expect(parseHiddenSamples(['https://a', 'https://b'])).toEqual(['https://a', 'https://b']);
    expect(parseHiddenSamples('["https://a"]')).toEqual(['https://a']);
  });

  it('drops anything that is not a url string', () => {
    expect(parseHiddenSamples(['https://a', '', 42, null])).toEqual(['https://a']);
    expect(parseHiddenSamples('nonsense')).toEqual([]);
  });
});

describe('editing the list', () => {
  it('adds and removes the user’s own', () => {
    const added = addUserSample([], mine());
    expect(added).toHaveLength(1);
    expect(removeUserSample(added, 'u1')).toEqual([]);
    expect(removeUserSample(added, 'other')).toEqual(added); // an unknown id changes nothing
  });

  it('never hides the same url twice', () => {
    const once = hideSample([], 'https://a');
    expect(hideSample(once, 'https://a')).toEqual(['https://a']);
    expect(hideSample(once, 'https://b')).toEqual(['https://a', 'https://b']);
  });
});
