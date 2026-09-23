import { describe, expect, it } from 'vitest';
import { DEFAULT_DATE_PRESETS, parseDatePresets } from '../../../packages/renderer/src/plugins/date-presets.js';

describe('parseDatePresets', () => {
  it('reads the default spec', () => {
    expect(parseDatePresets(DEFAULT_DATE_PRESETS)).toEqual([
      { entry: '3m', label: 'Last 3 months', term: '-3m' },
      { entry: '6m', label: 'Last 6 months', term: '-6m' },
      { entry: '1y', label: 'Past year', term: '-1y' },
      { entry: 'y', label: 'Year to date', term: 'ytd' },
    ]);
  });

  it('labels a count of one without the number', () => {
    expect(parseDatePresets('1m')[0]).toEqual({ entry: '1m', label: 'Last month', term: '-1m' });
    expect(parseDatePresets('1d')[0]).toEqual({ entry: '1d', label: 'Last day', term: '-1d' });
    expect(parseDatePresets('1w')[0]).toEqual({ entry: '1w', label: 'Last week', term: '-1w' });
  });

  it('1y is "Past year", not "Last year"', () => {
    // "Last year" reads as the previous CALENDAR year; this is a rolling window.
    expect(parseDatePresets('1y')[0]?.label).toBe('Past year');
    expect(parseDatePresets('2y')[0]?.label).toBe('Last 2 years');
  });

  it('reads the bare to-date anchors', () => {
    expect(parseDatePresets('y,q,m,w')).toEqual([
      { entry: 'y', label: 'Year to date', term: 'ytd' },
      { entry: 'q', label: 'Quarter to date', term: 'qtd' },
      { entry: 'm', label: 'Month to date', term: 'mtd' },
      { entry: 'w', label: 'Week to date', term: 'wtd' },
    ]);
  });

  it('takes a custom label after =', () => {
    expect(parseDatePresets('3m=Last quarter')[0]).toEqual({ entry: '3m=Last quarter', label: 'Last quarter', term: '-3m' });
  });

  it('skips an entry it cannot read rather than showing a broken row', () => {
    expect(parseDatePresets('3m,nonsense,1y').map((p) => p.term)).toEqual(['-3m', '-1y']);
    expect(parseDatePresets('3x')).toEqual([]);
  });

  it('tolerates whitespace and an empty spec', () => {
    expect(parseDatePresets(' 3m , 6m ').map((p) => p.term)).toEqual(['-3m', '-6m']);
    expect(parseDatePresets('')).toEqual([]);
    expect(parseDatePresets('   ')).toEqual([]);
  });

  it('drops a duplicate entry', () => {
    expect(parseDatePresets('3m,3m').map((p) => p.term)).toEqual(['-3m']);
  });
});
