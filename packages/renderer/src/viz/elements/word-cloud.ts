// packages/renderer/src/viz/elements/word-cloud.ts
//
// `<viz-word-cloud>` — terms sized by frequency, placed with `d3-cloud` and drawn
// into our own SVG.
//
// `d3-cloud` is a LAYOUT, not a renderer: it hands back a position, size and
// rotation per word and draws nothing. That is exactly what is wanted here —
// the SVG is ours, so it themes with the same CSS variables as every other
// element and a term can be a real `<text>` node rather than a canvas blob (which
// no screen reader and no text search can reach).
//
// The layout is O(terms x placement attempts) on the main thread, so the term
// count is capped by the caller and the run is generation-guarded: a resize while
// a layout is in flight abandons the old one rather than drawing it late.

import { LitElement, css, html, nothing, svg } from 'lit';
import type { PropertyValues } from 'lit';
import { readChartTheme, type CloudTerm } from './chart-data.js';
import { fitFontCeiling, scaleTermSizes } from './cloud-scale.js';
import { sameCloudTerms, sameVizOptions } from './same-input.js';

export interface CloudOptions {
  minFontSize?: number | undefined;
  maxFontSize?: number | undefined;
  /** Allow 90° rotated words. Default false — horizontal is markedly more readable. */
  rotate?: boolean | undefined;
}

/** One laid-out word, as d3-cloud returns it. */
interface PlacedWord {
  text: string;
  size: number;
  x: number;
  y: number;
  rotate: number;
  count: number;
}

export class VizWordCloud extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: relative;
      height: 100%;
      min-height: 100px;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    text {
      font-family: var(--viz-font-family, system-ui, sans-serif);
      font-weight: 600;
      cursor: default;
    }
    .dropped {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      padding: 2px 6px;
      font: 10px/1.3 var(--viz-font-family, system-ui, sans-serif);
      color: var(--viz-muted-text, rgba(127, 127, 127, 0.9));
      background: rgba(127, 127, 127, 0.08);
      pointer-events: none;
    }
    .empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      padding: 0.5rem 1rem;
      text-align: center;
      font: 12px/1.5 var(--viz-font-family, system-ui, sans-serif);
      color: var(--viz-muted-text, rgba(127, 127, 127, 0.9));
    }
  `;

  terms: CloudTerm[] = [];
  options: CloudOptions = {};
  emptyText = 'No words to show.';

  private placed: PlacedWord[] = [];
  /** Terms `d3-cloud` could not fit. Reported, never silently swallowed. */
  private dropped = 0;
  /** The input the layout on screen was computed from — see `same-input.ts`. */
  private laidOutTerms: readonly CloudTerm[] = [];
  private laidOutOptions: CloudOptions = {};
  private w = 0;
  private h = 0;
  private generation = 0;
  private ro: ResizeObserver | null = null;

  static override get properties() {
    return {
      terms: { attribute: false },
      options: { attribute: false },
      emptyText: { type: String },
      placed: { state: true },
      dropped: { state: true },
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.ro = new ResizeObserver(() => {
      // A layout is bound to the box it was computed for, so a resize has to
      // re-run it rather than rescale the result.
      const r = this.getBoundingClientRect();
      if (Math.abs(r.width - this.w) < 8 && Math.abs(r.height - this.h) < 8) return;
      void this.layout();
    });
    this.ro.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generation++;
    this.ro?.disconnect();
    this.ro = null;
  }

  override updated(changed: PropertyValues): void {
    // A new ARRAY of the same terms is not new data, and Lit cannot tell the
    // difference: `viz-panel` rebuilds `terms` on every render, so resizing a
    // column in the grid beside this cloud used to re-run the whole layout — and
    // a re-layout re-places every word. See `same-input.ts`.
    if ((changed.has('terms') || changed.has('options')) && !this.matchesLayout()) void this.layout();
    this.fitViewBox();
  }

  /** Is what is drawn already the answer for the current input? */
  private matchesLayout(): boolean {
    return sameCloudTerms(this.laidOutTerms, this.terms) && sameVizOptions(this.laidOutOptions, this.options);
  }

  /**
   * Record what the layout on screen was computed from.
   *
   * Called only where a layout has actually landed, never on entry: a run
   * abandoned by the generation guard has drawn nothing, and remembering its
   * input would suppress the re-run that is supposed to replace it.
   */
  private rememberLayoutInput(): void {
    this.laidOutTerms = this.terms;
    this.laidOutOptions = this.options;
  }

  /**
   * Crop the viewBox to the words actually drawn.
   *
   * `d3-cloud` packs outwards from the centre of the box it is given and stops
   * as soon as every word is placed, so a cloud of a few dozen terms sits in a
   * blob with a wide empty margin around it — dead space the pane could be
   * spending on legible text. Fitting the viewBox to the drawn extent scales
   * that blob up to the pane. Measured from the rendered SVG rather than from
   * the layout output because a rotated word's box is not its font metrics.
   */
  private fitViewBox(): void {
    const svg = this.renderRoot.querySelector('svg');
    if (!svg || this.placed.length === 0) return;
    // Includes the centring transform on the <g>, unlike the group's own getBBox.
    const b = svg.getBBox();
    if (b.width < 1 || b.height < 1) return;
    // The margin scales with the TYPE, not with the box. `getBBox` measures a
    // text node's layout box and the ink of a 600-weight glyph goes a little past
    // it, so a box fitted to within 2 units of the outermost word had the top and
    // side words shaved off against the panel edge — and how far past is a
    // fraction of the font size, not of the pane. A fraction of the pane would
    // also fight `113-viz-docking`, which holds this cloud to filling its pane.
    const biggest = this.placed.reduce((n, p) => Math.max(n, p.size), 0);
    const m = Math.max(2, Math.round(biggest * 0.12));
    svg.setAttribute('viewBox', `${b.x - m} ${b.y - m} ${b.width + m * 2} ${b.height + m * 2}`);
  }

  private async layout(): Promise<void> {
    const gen = ++this.generation;
    if (this.terms.length === 0) {
      this.placed = [];
      this.rememberLayoutInput();
      return;
    }
    const rect = this.getBoundingClientRect();
    const w = Math.max(80, Math.floor(rect.width));
    const h = Math.max(60, Math.floor(rect.height));
    const mod = await import('d3-cloud');
    if (gen !== this.generation || !this.isConnected) return;
    const cloud = (mod.default ?? mod) as unknown as () => CloudLayout;

    const minF = Math.max(6, this.options.minFontSize ?? 11);
    // The ceiling is derived from the box AND the term count, because d3-cloud
    // drops what it cannot place — see `fitFontCeiling`.
    const ceiling = this.options.maxFontSize ?? fitFontCeiling(this.terms.length, w, h, minF);

    const runLayout = (maxF: number): Promise<PlacedWord[]> => {
      const sized = scaleTermSizes(this.terms, minF, maxF);
      return new Promise<PlacedWord[]>((resolve) => {
        cloud()
          .size([w, h])
          .words(sized.map((t) => ({ text: t.term, size: t.size, count: t.count })))
          .padding(2)
          // Rotation is seeded off the term index rather than Math.random(), so a
          // re-layout (a resize, a filter change) does not reshuffle every word.
          .rotate((d: { text?: string }) => (this.options.rotate ? (hash(d.text ?? '') % 2 === 0 ? 0 : 90) : 0))
          .font('system-ui, sans-serif')
          .fontWeight('600')
          .fontSize((d: { size?: number }) => d.size ?? minF)
          .on('end', (words: PlacedWord[]) => resolve(words))
          .start();
      });
    };

    // Shrink and retry while a meaningful share of the terms is being dropped.
    // Two extra passes is enough to go from "6 of 53 fit" to nearly all of them,
    // and each pass is cheap next to the first (the font cache is warm).
    let maxF = ceiling;
    let words = await runLayout(maxF);
    for (let attempt = 0; attempt < 2 && words.length < this.terms.length * 0.9; attempt++) {
      const smaller = Math.max(minF + 2, Math.round(maxF * 0.6));
      if (smaller >= maxF) break;
      maxF = smaller;
      const retry = await runLayout(maxF);
      if (gen !== this.generation) return;
      // Keep whichever pass placed more — shrinking usually helps but is not
      // guaranteed to, and a worse result must not overwrite a better one.
      if (retry.length > words.length) words = retry;
      else break;
    }
    if (gen !== this.generation || !this.isConnected) return;
    this.placed = words;
    this.dropped = Math.max(0, this.terms.length - words.length);
    this.w = w;
    this.h = h;
    this.rememberLayoutInput();
  }

  override render() {
    if (this.terms.length === 0) return html`<div class="empty">${this.emptyText}</div>`;
    const theme = readChartTheme(this);
    const w = this.w || 300;
    const h = this.h || 200;
    const summary = `Word cloud of ${this.terms.length} ${this.terms.length === 1 ? 'term' : 'terms'}, largest ${this.terms[0]?.term ?? ''}`;
    return html`
      ${this.dropped > 0
        ? html`<div class="dropped" role="status">${this.dropped} more ${this.dropped === 1 ? 'word did' : 'words did'} not fit — make the pane bigger or show fewer words.</div>`
        : nothing}
      <svg viewBox="0 0 ${w} ${h}" role="img" aria-label=${summary} preserveAspectRatio="xMidYMid meet">
        <g transform="translate(${w / 2},${h / 2})">
          ${this.placed.map(
            // `svg` and NOT `html`, and this is the whole reason the cloud drew
            // nothing while reporting every word placed.
            //
            // Lit parses each template independently, so a nested template does
            // not inherit its parent's namespace. Under `html` these `<text>`
            // nodes were created in the HTML namespace — real elements that
            // `querySelectorAll('text')` finds and that carry every attribute
            // correctly, but which an `<svg>` does not render and which have no
            // `getBBox`. The bug looked like a layout failure and was a namespace
            // one; only the tag matters, the markup is unchanged.
            (p, i) => svg`
              <text text-anchor="middle" transform="translate(${p.x},${p.y}) rotate(${p.rotate})" font-size=${p.size} fill=${theme.palette[i % theme.palette.length] ?? theme.text}>
                <title>${p.text}: ${p.count.toLocaleString()}</title>
                ${p.text}
              </text>
            `,
          )}
        </g>
      </svg>
      ${nothing}
    `;
  }
}

/** Stable per-word pseudo-random, so a re-layout keeps each word's rotation. */
function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The slice of d3-cloud's fluent API this element uses. */
interface CloudLayout {
  size(s: [number, number]): CloudLayout;
  words(w: Array<{ text: string; size: number; count: number }>): CloudLayout;
  padding(n: number): CloudLayout;
  rotate(fn: (d: { text?: string }) => number): CloudLayout;
  font(f: string): CloudLayout;
  fontWeight(f: string): CloudLayout;
  fontSize(fn: (d: { size?: number }) => number): CloudLayout;
  on(ev: 'end', fn: (words: PlacedWord[]) => void): CloudLayout;
  start(): CloudLayout;
}

/** Guarded define — see `chart-element.ts`'s `defineCharts`. */
export function defineWordCloud(): void {
  if (!customElements.get('viz-word-cloud')) customElements.define('viz-word-cloud', VizWordCloud);
}
