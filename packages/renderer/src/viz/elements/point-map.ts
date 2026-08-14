// packages/renderer/src/viz/elements/point-map.ts
//
// `<viz-point-map>` — lat/lon points on raster tiles, drawn with Leaflet.
//
// Three decisions worth knowing before editing this:
//
// **It renders into the LIGHT DOM.** `createRenderRoot` returns `this`, so this
// element has no shadow root of its own. Leaflet styles its panes with a global
// stylesheet; behind a shadow boundary that CSS does not reach it. Every other
// element in this folder keeps its shadow root — this one cannot.
//
// **But having no shadow root of its own is not enough**, and that is what made
// maps unusable up to v0.0.372. The element is mounted inside `viz-panel`'s
// shadow root, and a `<style>` in `document.head` does not cross a shadow
// boundary either way round: `.leaflet-pane { position: absolute }` never
// applied, so every pane, tile and marker stacked in normal flow. The layers
// were all built correctly — the tiles and the circle markers were there in the
// DOM — they were simply piled down the page instead of being positioned. So the
// stylesheet goes into WHICHEVER ROOT the element actually lives in (see
// {@link adoptLeafletCss}), which is the document when it is in the light DOM
// and the host's shadow root when it is not.
//
// **Markers are `circleMarker`, not `marker`.** Leaflet's default marker is an
// image (`marker-icon.png`) resolved relative to the stylesheet, which is exactly
// the thing that breaks under a bundler and the reason half the Leaflet questions
// on the internet exist. A circle marker is SVG: no assets, no base-URL problem,
// and it can carry a magnitude by radius.
//
// **A tile failure is not a chart failure.** Tiles come from the network; the
// points do not. When tiles cannot load the markers still draw over a plain
// background and the element says so, because a map that renders blank offline is
// indistinguishable from a map with no data.

import { LitElement, html, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import type { CircleMarker, Map as LeafletMap, TileLayer } from 'leaflet';
import { readChartTheme, type MapPoint } from './chart-data.js';
import { markerRadiusRange, scaleMarkerRadii } from './marker-scale.js';

export interface MapOptions {
  tileUrl?: string | undefined;
  attribution?: string | undefined;
  /** Marker radius in px when no weight is mapped. */
  radius?: number | undefined;
  /** Scale marker radius by the weight channel. */
  scaleByWeight?: boolean | undefined;
}

type Leaflet = typeof import('leaflet');
type StyleRoot = Document | ShadowRoot;

let leafletPromise: Promise<Leaflet> | null = null;
let cssTextPromise: Promise<string> | null = null;
/** Roots that already carry the stylesheet. Weak, so a closed window's root goes. */
const styledRoots = new WeakSet<StyleRoot>();

/**
 * Load Leaflet once.
 *
 * Lazily, so a user who never opens a map downloads neither the library nor its
 * stylesheet — the whole point of the dynamic import.
 */
function leaflet(): Promise<Leaflet> {
  leafletPromise ??= import('leaflet').then((mod) => (mod.default ?? mod) as Leaflet);
  return leafletPromise;
}

/**
 * Leaflet's stylesheet, as text, fetched once and shared by every root.
 *
 * `?inline` hands back the text rather than letting Vite inject it into the
 * document, which is the whole point: injecting it into the document is exactly
 * what does NOT work here.
 */
function leafletCssText(): Promise<string> {
  cssTextPromise ??= import('leaflet/dist/leaflet.css?inline').then((m) => m.default as string);
  return cssTextPromise;
}

/**
 * Put Leaflet's stylesheet into the root this element actually lives in.
 *
 * A shadow root is styled independently of the document, so a map mounted inside
 * `viz-panel`'s shadow root gets nothing from `document.head` — its panes stay
 * `position: static` and the map falls apart. Once per root, not once per map:
 * several maps in one window share a root and would otherwise each add a copy.
 *
 * `adoptedStyleSheets` where it exists (one parsed sheet shared by every root),
 * a `<style>` element otherwise.
 */
async function adoptLeafletCss(root: StyleRoot): Promise<void> {
  if (styledRoots.has(root)) return;
  styledRoots.add(root);
  const css = await leafletCssText();
  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function') {
    try {
      leafletSheet ??= new CSSStyleSheet();
      if (leafletSheet.cssRules.length === 0) leafletSheet.replaceSync(css);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, leafletSheet];
      return;
    } catch {
      // Constructable stylesheets can be refused (a very old engine, or a CSP
      // that blocks them). The <style> below always works.
    }
  }
  const style = document.createElement('style');
  style.dataset['vizLeaflet'] = '';
  style.textContent = css;
  (root instanceof Document ? root.head : root).append(style);
}

let leafletSheet: CSSStyleSheet | null = null;

/** The document or shadow root an element is inside. */
function styleRootOf(el: Element): StyleRoot {
  const root = el.getRootNode();
  return root instanceof ShadowRoot || root instanceof Document ? root : document;
}

export class VizPointMap extends LitElement {
  /** Leaflet needs real global CSS and a measurable container — no shadow root. */
  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  points: MapPoint[] = [];
  options: MapOptions = {};
  emptyText = 'No points to map.';

  private map: LeafletMap | null = null;
  private tiles: TileLayer | null = null;
  private markers: CircleMarker[] = [];
  private ro: ResizeObserver | null = null;
  private generation = 0;
  private tileError = false;

  static override get properties() {
    return {
      points: { attribute: false },
      options: { attribute: false },
      emptyText: { type: String },
      tileError: { state: true },
    };
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.style.display = 'block';
    this.style.position = 'relative';
    this.style.height = '100%';
    this.style.minHeight = '120px';
    // Leaflet measures its container on creation; a panel splitter changes that
    // size without a window resize event, so it has to be told.
    this.ro = new ResizeObserver(() => this.map?.invalidateSize());
    this.ro.observe(this);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.generation++;
    this.ro?.disconnect();
    this.ro = null;
    this.map?.remove();
    this.map = null;
    this.tiles = null;
    this.markers = [];
  }

  override updated(changed: PropertyValues): void {
    if (changed.has('points') || changed.has('options')) void this.draw();
  }

  private async draw(): Promise<void> {
    const gen = ++this.generation;
    const host = this.querySelector('.map') as HTMLElement | null;
    if (!host || this.points.length === 0) return;
    // The CSS has to be in place BEFORE the map is built: Leaflet measures the
    // container and positions its panes on creation, and an unstyled container
    // measures wrong.
    const [L] = await Promise.all([leaflet(), adoptLeafletCss(styleRootOf(this))]);
    if (gen !== this.generation || !this.isConnected) return;

    const theme = readChartTheme(this);
    if (!this.map) {
      this.map = L.map(host, { attributionControl: true });
    }
    if (!this.tiles) {
      this.tiles = L.tileLayer(this.options.tileUrl ?? '', {
        attribution: this.options.attribution ?? '',
        maxZoom: 19,
      });
      // One flag, not one per failed tile: a map panned offline fires this for
      // every tile in the viewport.
      this.tiles.on('tileerror', () => {
        if (!this.tileError) this.tileError = true;
      });
      this.tiles.addTo(this.map);
    } else if (this.options.tileUrl && this.tiles.options.attribution !== undefined) {
      this.tiles.setUrl(this.options.tileUrl);
    }

    for (const m of this.markers) m.remove();
    this.markers = [];

    const baseRadius = this.options.radius ?? 6;
    const color = theme.palette[0] ?? '#2563eb';
    // One pass over the whole set, because a radius depends on the OTHER points:
    // the range is normalised over the weights actually present. See
    // `marker-scale.ts` for why it is a range rather than a multiplier.
    const range = markerRadiusRange(baseRadius);
    const radii = this.options.scaleByWeight ? scaleMarkerRadii(this.points, range.min, range.max) : null;

    for (const [index, p] of this.points.entries()) {
      const marker = L.circleMarker([p.lat, p.lon], {
        radius: radii ? (radii[index] ?? range.min) : baseRadius,
        color,
        weight: 1,
        fillColor: color,
        fillOpacity: 0.6,
      });
      if (p.label) marker.bindTooltip(String(p.label));
      marker.addTo(this.map);
      this.markers.push(marker);
    }

    // Fit to the data rather than opening on a world view — a map of three
    // Swiss cities opened at zoom 0 looks like an empty map.
    const bounds = L.latLngBounds(this.points.map((p) => [p.lat, p.lon] as [number, number]));
    if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    this.map.invalidateSize();
  }

  override render() {
    if (this.points.length === 0) {
      return html`<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:.5rem 1rem;text-align:center;font:12px/1.5 system-ui,sans-serif;color:rgba(127,127,127,.9)">
        ${this.emptyText}
      </div>`;
    }
    return html`
      <div
        class="map"
        role="img"
        aria-label="Map of ${this.points.length} ${this.points.length === 1 ? 'point' : 'points'}"
        style="position:absolute;inset:0;background:var(--viz-map-bg, #e5e7eb)"
      ></div>
      ${this.tileError
        ? html`<div role="status" style="position:absolute;left:0;right:0;bottom:0;z-index:500;padding:3px 8px;font:11px/1.35 system-ui,sans-serif;color:#92400e;background:rgba(255,251,235,.95)">
            Map tiles could not be loaded — the points are still plotted. Check the tile URL in Settings → Visualizations, or your connection.
          </div>`
        : nothing}
    `;
  }
}

/** Guarded define — see `chart-element.ts`'s `defineCharts`. */
export function definePointMap(): void {
  if (!customElements.get('viz-point-map')) customElements.define('viz-point-map', VizPointMap);
}
