import { describe, expect, it } from 'vitest';
import { csvFilename, frameToCsv, pointsToCsv, termsToCsv, toCsv } from '../../../packages/renderer/src/viz/viz-csv.js';
import type { VizFrame } from '../../../packages/renderer/src/viz/viz-aggregate.js';

describe('toCsv', () => {
  it('joins cells with commas and rows with CRLF, matching the importer dialect', () => {
    expect(
      toCsv([
        ['a', 'b'],
        [1, 2],
      ]),
    ).toBe('a,b\r\n1,2');
  });

  it('quotes a cell holding a comma, a quote or a newline', () => {
    expect(toCsv([['a,b']])).toBe('"a,b"');
    expect(toCsv([['say "hi"']])).toBe('"say ""hi"""');
    expect(toCsv([['two\nlines']])).toBe('"two\nlines"');
  });

  it('leaves an ordinary cell unquoted', () => {
    expect(toCsv([['plain']])).toBe('plain');
  });

  it('writes null and undefined as empty', () => {
    expect(toCsv([[null, undefined, '']])).toBe(',,');
  });

  it('writes booleans as words and numbers bare', () => {
    expect(toCsv([[true, false, 3.5]])).toBe('true,false,3.5');
  });
});

describe('termsToCsv', () => {
  it('writes a header and one row per term, in ranked order', () => {
    const csv = termsToCsv([
      { term: 'alpha', count: 3 },
      { term: 'beta', count: 1 },
    ]);
    expect(csv).toBe('Word,Count\r\nalpha,3\r\nbeta,1');
  });

  it('quotes a term that needs it', () => {
    expect(termsToCsv([{ term: 'well,known', count: 2 }])).toBe('Word,Count\r\n"well,known",2');
  });

  it('writes just the header for no terms', () => {
    expect(termsToCsv([])).toBe('Word,Count');
  });
});

describe('frameToCsv', () => {
  const frame = (over: Partial<VizFrame> = {}): VizFrame => ({
    categories: [
      { key: 'CH', label: 'CH', values: ['CH'] },
      { key: 'DE', label: 'DE', values: ['DE'] },
    ],
    series: [{ key: 'v:sum', label: 'Sum of Amount', points: [10, 5] }],
    rowCount: 2,
    truncated: false,
    skipped: 0,
    ...over,
  });

  it('writes one column per series and one row per category', () => {
    expect(frameToCsv(frame())).toBe('Category,Sum of Amount\r\nCH,10\r\nDE,5');
  });

  it('leaves a null point EMPTY rather than writing a zero the chart never drew', () => {
    const f = frame({ series: [{ key: 'v', label: 'Sum', points: [10, null] }] });
    expect(frameToCsv(f)).toBe('Category,Sum\r\nCH,10\r\nDE,');
  });

  it('writes every series as its own column', () => {
    const f = frame({
      series: [
        { key: 'a', label: 'Count', points: [2, 1] },
        { key: 'b', label: 'Sum', points: [10, 5] },
      ],
    });
    expect(frameToCsv(f)).toBe('Category,Count,Sum\r\nCH,2,10\r\nDE,1,5');
  });

  it('quotes a series label containing a comma', () => {
    const f = frame({ series: [{ key: 'a', label: 'Sum, total', points: [1, 2] }] });
    expect(frameToCsv(f).split('\r\n')[0]).toBe('Category,"Sum, total"');
  });
});

describe('pointsToCsv', () => {
  it('writes just the coordinates when nothing else is mapped', () => {
    expect(pointsToCsv([{ lat: 47, lon: 8 }])).toBe('Latitude,Longitude\r\n47,8');
  });

  it('adds a Label column only when some point has one', () => {
    expect(pointsToCsv([{ lat: 47, lon: 8, label: 'Bern' }])).toBe('Latitude,Longitude,Label\r\n47,8,Bern');
  });

  it('adds a Weight column only when some point has one', () => {
    const csv = pointsToCsv([
      { lat: 47, lon: 8, weight: 3 },
      { lat: 46, lon: 7 },
    ]);
    expect(csv).toBe('Latitude,Longitude,Weight\r\n47,8,3\r\n46,7,');
  });

  it('writes just the header for no points', () => {
    expect(pointsToCsv([])).toBe('Latitude,Longitude');
  });
});

describe('csvFilename', () => {
  it('slugs a name and appends the extension', () => {
    expect(csvFilename('Top words')).toBe('Top-words.csv');
  });

  it('strips characters that have no business in a filename', () => {
    expect(csvFilename('By country / 2026 (draft)')).toBe('By-country-2026-draft.csv');
  });

  it('falls back rather than producing a dotfile', () => {
    expect(csvFilename('   ')).toBe('visualization.csv');
    expect(csvFilename('///')).toBe('visualization.csv');
  });
});
