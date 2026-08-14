import { describe, expect, it } from 'vitest';
import type { ColumnSpec, Row } from '../../../packages/shared/src/types.js';
import { countNonEmpty, emptyChannelNote, emptyChannels, noTermsNote } from '../../../packages/renderer/src/viz/viz-diagnose.js';

const col = (field: string, label = field): ColumnSpec => ({ field, label, type: 'string' });

let n = 0;
const row = (data: Record<string, unknown>): Row => ({ id: `r${++n}`, tableId: 't', data, updatedAt: 0 });

describe('countNonEmpty', () => {
  it('counts only rows carrying a value', () => {
    const rows = [row({ a: 'x' }), row({ a: '' }), row({ a: null }), row({}), row({ a: '  ' }), row({ a: 0 })];
    // 'x' and 0 count; '', whitespace, null and absent do not — 0 is a value.
    expect(countNonEmpty(rows, 'a')).toBe(2);
  });

  it('treats an empty list as absent, like array-cell.ts does', () => {
    expect(countNonEmpty([row({ tags: [] }), row({ tags: ['x'] })], 'tags')).toBe(1);
  });
});

describe('emptyChannels', () => {
  const columns = [col('body', 'Body'), col('title', 'Title')];

  it('reports a channel whose column is empty in every row', () => {
    const rows = [row({ title: 'a', body: '' }), row({ title: 'b' })];
    const out = emptyChannels(rows, columns, [{ channel: 'TEXT', label: 'Text column', field: 'body' }]);
    expect(out).toEqual([{ label: 'Text column', column: 'Body' }]);
  });

  it('says nothing when the column has even one value', () => {
    const rows = [row({ body: '' }), row({ body: 'something' })];
    expect(emptyChannels(rows, columns, [{ channel: 'TEXT', label: 'Text column', field: 'body' }])).toEqual([]);
  });

  it('ignores an UNMAPPED channel — that is a different message', () => {
    expect(emptyChannels([row({})], columns, [{ channel: 'TEXT', label: 'Text', field: '' }])).toEqual([]);
  });

  it('ignores a channel whose column does not exist — the aggregator reports that', () => {
    // The renamed-column case. Blaming it for being "empty" would point the user
    // at the data instead of at the broken reference.
    expect(emptyChannels([row({})], columns, [{ channel: 'TEXT', label: 'Text', field: 'gone' }])).toEqual([]);
  });

  it('says nothing for an empty table — that is its own obvious case', () => {
    expect(emptyChannels([], columns, [{ channel: 'TEXT', label: 'Text', field: 'body' }])).toEqual([]);
  });

  it('reports several empty channels at once', () => {
    const rows = [row({ x: 1 })];
    const cols = [col('a', 'Alpha'), col('b', 'Beta')];
    const out = emptyChannels(rows, cols, [
      { channel: 'LAT', label: 'Latitude', field: 'a' },
      { channel: 'LON', label: 'Longitude', field: 'b' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('emptyChannelNote', () => {
  it('is null when there is nothing to say', () => {
    expect(emptyChannelNote([], 10)).toBeNull();
  });

  it('names the column, the row count and the way to fix it', () => {
    const note = emptyChannelNote([{ label: 'Text column', column: 'Body' }], 1204);
    expect(note).toContain('“Body”');
    // The note groups digits for the reader's locale, so the separator is the
    // runner's, not a comma — this failed on a de-CH machine ("1’204 rows").
    expect(note).toContain(`${(1204).toLocaleString()} rows`);
    expect(note).toContain('Text column');
    expect(note).toContain('Edit');
  });

  it('uses the singular for one row', () => {
    expect(emptyChannelNote([{ label: 'X', column: 'Y' }], 1)).toContain('1 row.');
  });

  it('lists both columns when two are empty', () => {
    const note = emptyChannelNote(
      [
        { label: 'Latitude', column: 'Lat' },
        { label: 'Longitude', column: 'Lon' },
      ],
      5,
    );
    expect(note).toContain('“Lat” and “Lon”');
    expect(note).toContain('are empty');
  });
});

describe('noTermsNote', () => {
  it('points at the word rules, not at the mapping', () => {
    // The column HAS text here, so "pick another column" would be wrong advice.
    const note = noTermsNote({ minLength: 3, stopWordsOn: true, numbersExcluded: true });
    // Names the button that actually holds them. It said "Chart" until v0.0.370,
    // when that button became "Edit" (the definition) and "Settings" (this view).
    expect(note).toContain('Settings');
    expect(note).toContain('3 characters');
    expect(note).toContain('common word');
    expect(note).toContain('a number');
  });

  it('lists only the rules that are actually on', () => {
    const note = noTermsNote({ minLength: 1, stopWordsOn: false, numbersExcluded: false });
    expect(note).not.toContain('characters');
    expect(note).not.toContain('common word');
    expect(note).not.toContain('a number');
    expect(note).toContain('No words left to show.');
  });
});
