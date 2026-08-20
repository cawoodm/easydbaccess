import { describe, expect, it } from 'vitest';
import { buildChartConfig, buildDatasets, colorsPerCategory, showsLegend, type ChartOptions } from '../../../packages/renderer/src/viz/elements/chart-config.js';
import type { ChartData, ChartTheme } from '../../../packages/renderer/src/viz/elements/chart-data.js';

/**
 * How a chart is DRAWN — the part that used to live inside the element, where a
 * canvas was needed to see any of it.
 *
 * Every assertion here is a styling decision that was made deliberately, so a
 * later change to any of them shows up as a failing name rather than as a chart
 * that quietly looks different.
 */

const THEME: ChartTheme = {
  palette: ['#p1', '#p2', '#p3'],
  grid: '#grid',
  text: '#text',
  mutedText: '#muted',
  surface: '#surface',
  fontFamily: 'test-font',
  fontSize: 12,
};

const NUM = (n: number) => n.toFixed(0);

/** Categories with one value each, for `n` series. */
function data(categories: string[], series = 1): ChartData {
  return {
    categories,
    series: Array.from({ length: series }, (_, s) => ({ label: `s${s + 1}`, points: categories.map((_, i) => i + s) })),
  };
}

function datasets(kind: 'bar' | 'column' | 'line' | 'pie', d: ChartData, o: ChartOptions = {}) {
  return buildDatasets(kind, d, o, THEME);
}

describe('colouring', () => {
  it('gives a lone bar series one colour per category', () => {
    // One flat blue for eight countries is a chart that has to be read off its
    // axis labels. A pie already did this; now the bars agree with it.
    const [ds] = datasets('column', data(['CH', 'DE', 'GB']));
    expect(ds?.['backgroundColor']).toEqual(['#p1', '#p2', '#p3']);
  });

  it('cycles the palette when there are more categories than colours', () => {
    const [ds] = datasets('column', data(['a', 'b', 'c', 'd']));
    expect(ds?.['backgroundColor']).toEqual(['#p1', '#p2', '#p3', '#p1']);
  });

  it('goes back to one colour per SERIES once there are two', () => {
    // With two series the colour IS the series — it is the only thing a legend
    // can mean.
    const all = datasets('column', data(['CH', 'DE'], 2));
    expect(all[0]?.['backgroundColor']).toBe('#p1');
    expect(all[1]?.['backgroundColor']).toBe('#p2');
  });

  it('colours a pie per slice however many series there are', () => {
    const [ds] = datasets('pie', data(['CH', 'DE', 'GB']));
    expect(ds?.['backgroundColor']).toEqual(['#p1', '#p2', '#p3']);
  });

  it('draws a line in one colour, because a two-colour line means nothing', () => {
    const [ds] = datasets('line', data(['Jan', 'Feb']));
    expect(ds?.['borderColor']).toBe('#p1');
    expect(colorsPerCategory('line', data(['Jan']))).toBe(false);
  });

  it('draws the topN tail grey, and only the tail', () => {
    // "Other" is not a category the user has — it is everything they did not ask
    // about — and a palette colour let the biggest bar look like the most
    // interesting one.
    const [ds] = datasets('column', data(['CH', 'DE', 'Other']), { mutedCategory: 'Other' });
    expect(ds?.['backgroundColor']).toEqual(['#p1', '#p2', '#muted']);
  });

  it('mutes nothing when no tail was folded', () => {
    const [plain] = datasets('column', data(['CH', 'Other']));
    expect(plain?.['backgroundColor']).toEqual(['#p1', '#p2']);
    const [blank] = datasets('column', data(['CH', 'Other']), { mutedCategory: '' });
    expect(blank?.['backgroundColor']).toEqual(['#p1', '#p2']);
  });
});

describe('bar and slice shape', () => {
  it('rounds the value end of a bar and leaves the baseline square', () => {
    const [ds] = datasets('column', data(['a', 'b']));
    expect(ds?.['borderRadius']).toBe(4);
    expect(ds?.['borderSkipped']).toBe('start');
  });

  it('caps how wide a bar can get, so two categories are not two slabs', () => {
    const [ds] = datasets('column', data(['a', 'b']));
    expect(ds?.['maxBarThickness']).toBe(56);
  });

  it('separates pie slices with the surface colour, not an outline', () => {
    const [ds] = datasets('pie', data(['a', 'b']));
    expect(ds?.['borderColor']).toBe('#surface');
    expect(ds?.['borderWidth']).toBe(2);
  });

  it('keeps a line honest about gaps', () => {
    // Joining across a null would draw a value that is not there.
    const [ds] = datasets('line', data(['a', 'b']));
    expect(ds?.['spanGaps']).toBe(false);
  });

  it('fills and curves a line only when asked', () => {
    const [plain] = datasets('line', data(['a', 'b']));
    expect(plain?.['fill']).toBe(false);
    expect(plain?.['tension']).toBe(0);
    const [fancy] = datasets('line', data(['a', 'b']), { area: true, smooth: true });
    expect(fancy?.['fill']).toBe(true);
    expect(fancy?.['tension']).toBe(0.35);
  });
});

describe('the legend', () => {
  it('is hidden for a single series — it would name what is already on the axis', () => {
    expect(showsLegend('column', data(['a', 'b']), {})).toBe(false);
  });

  it('is shown once there are two series', () => {
    expect(showsLegend('column', data(['a'], 2), {})).toBe(true);
  });

  it('is a pie chart KEY, so it appears with more than one slice', () => {
    expect(showsLegend('pie', data(['a', 'b']), {})).toBe(true);
    expect(showsLegend('pie', data(['only']), {})).toBe(false);
  });

  it('does what the option says, either way', () => {
    expect(showsLegend('column', data(['a']), { legend: true })).toBe(true);
    expect(showsLegend('pie', data(['a', 'b']), { legend: false })).toBe(false);
  });
});

describe('the plot area', () => {
  /** The options object, indexable — Chart.js's own types are a deep union. */
  function opts(kind: 'bar' | 'column' | 'line' | 'pie', d: ChartData, o: ChartOptions = {}): Record<string, unknown> {
    return buildChartConfig(kind, d, o, THEME, NUM).options as unknown as Record<string, unknown>;
  }

  it('keeps the drawing off the panel edge', () => {
    // Chart.js draws to the canvas bounds, so the top tick label and the legend
    // sat against the window frame.
    expect(opts('column', data(['a']))['layout']).toEqual({ padding: 8 });
  });

  it('lays a bar chart on its side and a column chart upright', () => {
    expect(opts('bar', data(['a']))['indexAxis']).toBe('y');
    expect(opts('column', data(['a']))['indexAxis']).toBeUndefined();
  });

  it('puts the value scale on the axis the bars run along', () => {
    const horizontal = opts('bar', data(['a'])) as { scales: Record<string, Record<string, unknown>> };
    expect(horizontal.scales['x']?.['beginAtZero']).toBe(true);
    const upright = opts('column', data(['a'])) as { scales: Record<string, Record<string, unknown>> };
    expect(upright.scales['y']?.['beginAtZero']).toBe(true);
  });

  it('gives a pie no scales at all', () => {
    expect(opts('pie', data(['a']))['scales']).toBeUndefined();
  });

  it('drops the gridlines along the categories', () => {
    // They are labels, not a scale: a line per category is a cage around the bars.
    const upright = opts('column', data(['a'])) as { scales: Record<string, Record<string, unknown>> };
    expect(upright.scales['x']?.['grid']).toEqual({ display: false });
    expect((upright.scales['y']?.['grid'] as Record<string, unknown>)['color']).toBe('#grid');
  });

  it('mutes the tick labels and keeps the axis title full strength', () => {
    const upright = opts('column', data(['a']), { yTitle: 'Nights' }) as { scales: Record<string, Record<string, unknown>> };
    expect((upright.scales['y']?.['ticks'] as Record<string, unknown>)['color']).toBe('#muted');
    expect(upright.scales['y']?.['title']).toMatchObject({ display: true, text: 'Nights', color: '#text' });
    expect(upright.scales['x']?.['title']).toEqual({ display: false });
  });

  it('formats a tick with the caller number format', () => {
    const upright = opts('column', data(['a'])) as { scales: Record<string, Record<string, unknown>> };
    const cb = (upright.scales['y']?.['ticks'] as { callback: (v: unknown) => string }).callback;
    expect(cb(1234.6)).toBe('1235');
    expect(cb('n/a')).toBe('n/a');
  });
});

describe('the tooltip', () => {
  function label(kind: 'bar' | 'column' | 'pie', ctx: Record<string, unknown>): string {
    const options = buildChartConfig(kind, data(['a']), {}, THEME, NUM).options as unknown as {
      plugins: { tooltip: { callbacks: { label: (c: Record<string, unknown>) => string } } };
    };
    return options.plugins.tooltip.callbacks.label(ctx);
  }

  it('names the series and formats the number', () => {
    expect(label('column', { dataset: { label: 'Nights' }, parsed: { y: 1234.6 } })).toBe('Nights: 1235');
  });

  it('reads the value off the axis the bars run along', () => {
    expect(label('bar', { dataset: { label: 'Nights' }, parsed: { x: 12.4 } })).toBe('Nights: 12');
  });

  it('names the SLICE on a pie, where the series name says nothing', () => {
    expect(label('pie', { label: 'CH', parsed: 21 })).toBe('CH: 21');
  });
});
