// packages/renderer/src/viz/elements/chart-data.ts
//
// The neutral data shape every drawing element in this folder takes, and the
// theme it reads.
//
// **Nothing under `viz/elements/` may import `@easydb/shared`.** These files are
// destined for the `@marccawood/lit-charts` / `lit-map` / `lit-wordcloud` packages
// alongside `@marccawood/lit-dialogs`, and an element that knows about `Row`,
// `ColumnSpec` or `VizFrame` is not a reusable component — it is easyDBAccess
// code in a different repository. So the app adapts its `VizFrame` onto these
// types (see `viz/viz-panel.ts`) rather than the element reaching into the store.
//
// Theming is by CSS custom property rather than by configuration, for the same
// reason: a package cannot know the host app's palette, and a consumer that can
// restyle a chart with CSS needs no API for it. Every variable has a fallback, so
// an element dropped into a page with no theme still draws.

/** One drawn series: a label and one value per category (null = no value). */
export interface ChartSeries {
  label: string;
  points: Array<number | null>;
}

/** What a categorical chart draws. `categories.length === series[n].points.length`. */
export interface ChartData {
  categories: string[];
  series: ChartSeries[];
}

/** One plotted point on a map. */
export interface MapPoint {
  lat: number;
  lon: number;
  label?: string | undefined;
  weight?: number | undefined;
}

/** One term in a cloud, with how often it occurred. */
export interface CloudTerm {
  term: string;
  count: number;
}

/** Colours and type treatment a chart element draws with. */
export interface ChartTheme {
  /** Series colours, cycled. */
  palette: string[];
  /** Axis lines, ticks, borders. */
  grid: string;
  /** Labels and legend text. */
  text: string;
  /** Muted text — the empty-state and note lines, and the `topN` tail's colour. */
  mutedText: string;
  /**
   * What the chart is drawn ON.
   *
   * Used as the gap between one pie slice and the next: a slice separated by the
   * panel's own colour reads as a gap, where an outline in any other colour reads
   * as a border drawn around each slice.
   */
  surface: string;
  fontFamily: string;
  fontSize: number;
}

const DEFAULT_PALETTE = ['#2563eb', '#0891b2', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#ca8a04', '#dc2626'];

function cssVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

/**
 * Read the theme off an element's computed style.
 *
 * `--viz-palette` is a comma-separated list so a host can restyle every series
 * with one declaration; individual `--viz-color-1..8` override single slots,
 * which is what a "make series 3 red" tweak actually wants.
 */
export function readChartTheme(el: HTMLElement): ChartTheme {
  const s = getComputedStyle(el);
  const listed = cssVar(s, '--viz-palette', '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const base = listed.length > 0 ? listed : DEFAULT_PALETTE;
  const palette = base.map((c, i) => cssVar(s, `--viz-color-${i + 1}`, c));
  const fontSizeRaw = Number.parseFloat(cssVar(s, '--viz-font-size', ''));
  return {
    palette,
    grid: cssVar(s, '--viz-grid', 'rgba(127,127,127,0.25)'),
    text: cssVar(s, '--viz-text', s.color || '#111827'),
    mutedText: cssVar(s, '--viz-muted-text', 'rgba(127,127,127,0.9)'),
    // Not read off `background-color`: the panel is transparent over the window's
    // own background, so the computed value is `rgba(0,0,0,0)` and a slice gap
    // painted in it is a black line.
    surface: cssVar(s, '--viz-surface', '#fff'),
    fontFamily: cssVar(s, '--viz-font-family', s.fontFamily || 'system-ui, sans-serif'),
    fontSize: Number.isFinite(fontSizeRaw) && fontSizeRaw > 0 ? fontSizeRaw : 12,
  };
}

/** `#rrggbb` (or any colour) at a given alpha, for fills under a stroke. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  const short = /^#([0-9a-f]{3})$/i.exec(color.trim());
  if (short) {
    const [r, g, b] = [...(short[1] as string)].map((c) => Number.parseInt(c + c, 16));
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // A named colour or an rgb()/hsl() string: let the browser resolve it and
  // hand back something that at least draws, rather than guessing at parsing.
  return color;
}
