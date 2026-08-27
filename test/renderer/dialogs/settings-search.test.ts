import { describe, expect, it } from 'vitest';
import type { SettingsFieldSpec } from '../../../packages/shared/src/plugin-api.js';
import { countFields, fieldHaystack, fieldMatches, matchSettings, searchTerms, type SearchTab } from '../../../packages/renderer/src/dialogs/settings-search.js';

/**
 * Finding a setting without knowing its tab. The dialog has one tab per feature
 * and a user knows the words, not the tab.
 */

const field = (over: Partial<SettingsFieldSpec> & { key: string; label: string }): SettingsFieldSpec => ({ type: 'string', ...over });

const TABS: SearchTab[] = [
  {
    id: 'grid',
    name: 'Table grid',
    fields: [
      field({ key: 'highlightNulls', label: 'Highlight empty cells', description: 'An empty cell gets a pink background.' }),
      field({ key: 'windowRowsFrom', label: 'Read big tables one page at a time (rows)', type: 'number' }),
    ],
  },
  {
    id: 'links',
    name: 'Links',
    fields: [field({ key: 'protocols', label: 'Protocols that may be links', description: 'A list of protocols means those are the only links.', help: 'Leave it empty for the default.' })],
  },
  {
    id: 'viz',
    name: 'Visualizations',
    fields: [field({ key: 'tileUrl', label: 'Map tile URL template', description: 'Where map visualizations fetch their background tiles.' })],
  },
];

describe('searchTerms', () => {
  it('lower-cases, splits on whitespace and drops repeats', () => {
    expect(searchTerms('  Map   TILE map ')).toEqual(['map', 'tile']);
  });

  it('is empty for an empty query, which is what "not searching" means', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('fieldHaystack', () => {
  it('covers the tab name, label, key, description, help and options', () => {
    const hay = fieldHaystack('Table grid', field({ key: 'sortDescFirst', label: 'Sort descending first', description: 'Dates read high to low.', help: 'Two clicks otherwise.', options: ['Asc'] }));
    for (const word of ['table grid', 'sort descending', 'sortdescfirst', 'high to low', 'two clicks', 'asc']) {
      expect(hay, word).toContain(word);
    }
  });
});

describe('fieldMatches', () => {
  const f = TABS[0]!.fields[0]!;

  it('matches on the label, on the prose, and case-blind', () => {
    expect(fieldMatches('Table grid', f, ['empty'])).toBe(true);
    expect(fieldMatches('Table grid', f, ['PINK'])).toBe(true);
  });

  it('matches on the tab name, which a field label rarely repeats', () => {
    expect(fieldMatches('Table grid', f, ['grid'])).toBe(true);
  });

  it('needs EVERY word, so a second word narrows', () => {
    expect(fieldMatches('Table grid', f, ['pink', 'background'])).toBe(true);
    expect(fieldMatches('Table grid', f, ['pink', 'protocol'])).toBe(false);
  });
});

describe('matchSettings', () => {
  it('groups the matches under their own tabs, in tab order', () => {
    const groups = matchSettings(TABS, 'map');
    expect(groups.map((g) => g.name)).toEqual(['Visualizations']);
    expect(groups[0]!.fields.map((f) => f.key)).toEqual(['tileUrl']);
  });

  it('reaches across tabs — the whole point of searching', () => {
    // "links" is the Links tab's name and a word in the grid tab's prose? No:
    // it is only in Links, so a cross-tab query needs a word that really spans.
    const groups = matchSettings(TABS, 'a');
    expect(groups.length).toBeGreaterThan(1);
  });

  it('leaves a tab out entirely when nothing in it matches', () => {
    expect(matchSettings(TABS, 'protocols').map((g) => g.id)).toEqual(['links']);
  });

  it('takes a whole tab when the tab name is the query', () => {
    expect(matchSettings(TABS, 'table grid').map((g) => g.fields.length)).toEqual([2]);
  });

  it('is empty for no match, and for no query — not everything', () => {
    expect(matchSettings(TABS, 'zzz')).toEqual([]);
    expect(matchSettings(TABS, '')).toEqual([]);
    expect(matchSettings(TABS, '   ')).toEqual([]);
  });
});

describe('countFields', () => {
  it('counts the fields, not the tabs', () => {
    expect(countFields(matchSettings(TABS, 'table grid'))).toBe(2);
    expect(countFields([])).toBe(0);
  });
});
