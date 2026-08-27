import { describe, expect, it } from 'vitest';
import { fieldMatches, hitCount, hitsByTab, searchSettings, searchTerms, type SearchableTab } from '../../../packages/renderer/src/dialogs/settings-search.js';

/**
 * Finding a setting by name, across every tab.
 *
 * Which tab a setting lives in is an implementation fact — so the search covers
 * all of them at once and the answer names the tab it found each field in.
 */

const TABS: SearchableTab[] = [
  {
    id: '__general__',
    name: 'General',
    fields: [
      { key: 'workspaceTitle', label: 'Workspace title', description: 'Shown in the header instead of "easyDBAccess".' },
      { key: 'secrets', label: 'Secrets', description: 'One name: value per line. Tokens, passwords, API keys.' },
    ],
  },
  {
    id: 'grid',
    name: 'Table grid',
    fields: [
      { key: 'sortDescFirst', label: 'Sort descending first', description: 'Clicking a column header sorts descending, then ascending, then off.' },
      { key: 'highlightNulls', label: 'Highlight empty cells', description: 'An empty cell gets a pink background.' },
    ],
  },
  {
    id: 'windows',
    name: 'Windows',
    fields: [{ key: 'colors', label: 'Colours a window can be painted', description: 'Hex values or HTML colour names.', help: 'The title text is white.' }],
  },
  { id: 'empty', name: 'Nothing', fields: [] },
];

describe('searchTerms', () => {
  it('splits on whitespace and lowercases', () => {
    expect(searchTerms(' Map  TILE ')).toEqual(['map', 'tile']);
  });

  it('is empty for an empty or blank query', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('fieldMatches', () => {
  const field = TABS[2]!.fields[0]!;

  it('matches a word from the label, whatever the case', () => {
    expect(fieldMatches(field, 'Windows', ['COLOURS'])).toBe(true);
  });

  it('matches a substring, not only a prefix', () => {
    // "colour" has to find "Colours a window can be painted".
    expect(fieldMatches(field, 'Windows', ['colour'])).toBe(true);
    expect(fieldMatches(field, 'Windows', ['paint'])).toBe(true);
  });

  it('matches the description and the help text', () => {
    expect(fieldMatches(field, 'Windows', ['hex'])).toBe(true);
    expect(fieldMatches(field, 'Windows', ['white'])).toBe(true);
  });

  it('matches the KEY, which is what the docs call the setting', () => {
    expect(fieldMatches(field, 'Windows', ['colors'])).toBe(true);
  });

  it('matches the tab name, so a tab can be searched for by name', () => {
    expect(fieldMatches(field, 'Windows', ['windows'])).toBe(true);
  });

  it('needs EVERY word: adding one narrows the search', () => {
    expect(fieldMatches(field, 'Windows', ['window', 'hex'])).toBe(true);
    expect(fieldMatches(field, 'Windows', ['window', 'ftp'])).toBe(false);
  });

  it('matches everything when there is nothing to look for', () => {
    expect(fieldMatches(field, 'Windows', [])).toBe(true);
  });
});

describe('searchSettings', () => {
  it('answers nothing for an empty query, rather than everything', () => {
    // The dialog shows its tabs in that case — a result list of every setting
    // in the app would be a worse version of the tabs.
    expect(searchSettings(TABS, '')).toEqual([]);
    expect(searchSettings(TABS, '  ')).toEqual([]);
  });

  it('groups the matches by tab, in registered order', () => {
    const hits = searchSettings(TABS, 'colour');
    expect(hits).toEqual([{ tabId: 'windows', tabName: 'Windows', keys: ['colors'] }]);
  });

  it('reaches across tabs for one query', () => {
    // "cell" is in the grid tab's label and nowhere else; "colour" only in
    // Windows. One query, two tabs.
    const hits = searchSettings(TABS, 'c');
    expect(hits.map((h) => h.tabId)).toContain('grid');
    expect(hits.map((h) => h.tabId)).toContain('windows');
  });

  it('finds the General tab’s own fields, which are not registered specs', () => {
    expect(searchSettings(TABS, 'password')).toEqual([{ tabId: '__general__', tabName: 'General', keys: ['secrets'] }]);
  });

  it('leaves out a tab with no match, and a tab with no fields', () => {
    const hits = searchSettings(TABS, 'descending');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.keys).toEqual(['sortDescFirst']);
  });

  it('keeps a tab’s own field order', () => {
    const hits = searchSettings(TABS, 'grid');
    expect(hits[0]?.keys).toEqual(['sortDescFirst', 'highlightNulls']);
  });

  it('answers an empty list for a query nothing matches', () => {
    expect(searchSettings(TABS, 'zzzz')).toEqual([]);
  });
});

describe('hitCount and hitsByTab', () => {
  it('counts every matching field, not the tabs', () => {
    const hits = searchSettings(TABS, 'grid');
    expect(hitCount(hits)).toBe(2);
    expect(hitsByTab(hits)).toEqual({ grid: 2 });
  });

  it('is zero and empty for no hits', () => {
    expect(hitCount([])).toBe(0);
    expect(hitsByTab([])).toEqual({});
  });
});
