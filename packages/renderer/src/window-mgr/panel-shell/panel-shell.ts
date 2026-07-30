// packages/renderer/src/window-mgr/panel-shell/panel-shell.ts
/**
 * In-repo replacement for jsPanel4 (see the plan
 * .claude/plans/2026-07-30-replace-jspanel-with-panel-shell.md for why).
 *
 * Deliberate contract compatibility (index.html CSS, panzoom.ts, 12 e2e specs):
 *  - .jsPanel-* class names,
 *  - the instance IS the DOM element (getElementById(id).minimize() works),
 *  - front(undefined, false) fronts WITHOUT firing onfronted,
 *  - status: normalized | minimized | maximized | smallified | closed.
 *
 * What jsPanel got wrong is built in here instead of patched around:
 *  - restore-to-maximized memory (state.ts) — no maximized-memory.ts,
 *  - maximize fills the VISIBLE canvas through pan/zoom (counter-transform)
 *    and re-fits on container resize — no maximize-fill.ts / refit-panels.ts,
 *  - one onstatuschange per user action, fired after the DOM settled,
 *  - drag/resize deltas divided by the canvas scale,
 *  - dblclick-to-maximize and status-dependent cursors — no panel-titlebar.ts.
 */
import { MIN_H, MIN_W } from '../geometry.js';
import { dragRect, resizeRect, type Edge, type Rect } from './geometry-math.js';
import {
  initialState,
  persistFlags,
  transition,
  type PanelAction,
  type PanelStatus,
} from './state.js';
import './panel-shell.css';

export interface ShellViewport {
  getState(): { x: number; y: number; scale: number };
  subscribe(cb: () => void): () => void;
}

export interface PanelShellOptions {
  id: string;
  container: HTMLElement;
  title: string;
  logo?: string | undefined;
  color?: string | undefined;
  content: HTMLElement;
  footerToolbar?: HTMLElement | undefined;
  contentSize?: { w: number; h: number } | undefined;
  panelSize?: { w: number; h: number } | undefined;
  position?: { x: number; y: number } | { centerTopOffset: number } | 'center' | undefined;
  minimizeTo?: string | undefined;
  boot?: { minimized?: boolean; maximized?: boolean } | undefined;
  viewport?: ShellViewport | undefined;
  onfronted?: (() => void) | undefined;
  onstatuschange?: ((panel: PanelShellEl) => void) | undefined;
  onmoved?: (() => void) | undefined;
  onresized?: (() => void) | undefined;
  onclosed?: (() => void) | undefined;
}

export type PanelShellEl = HTMLDivElement & {
  status: PanelStatus;
  minimize(): void;
  maximize(callback?: undefined, donotfront?: boolean): void;
  normalize(): void;
  smallify(): void;
  front(callback?: undefined, execOnFrontedCallbacks?: boolean): void;
  close(): void;
  setHeaderTitle(title: string): void;
  setHeaderLogo(svg: string): void;
  persistFlags(): { minimized: boolean; maximized: boolean };
};

/** Titlebar contents where a drag or dblclick must NOT start. */
const INTERACTIVE = 'input, textarea, select, button, a, .jsPanel-controlbar';

/**
 * Whether `e` originated on (or inside) an INTERACTIVE element — checked via
 * `composedPath()`, not `e.target`. The footer/controlbar may host a Lit
 * custom element (panel-footer, panel-search) with its own shadow root; for a
 * listener attached outside that shadow tree, `e.target` is retargeted to the
 * shadow HOST, which doesn't match `button`/`input` and has no matching
 * ancestor either — so `e.target.closest(INTERACTIVE)` misses it, but
 * `composedPath()` still walks through the real (shadow-internal) elements.
 */
function isInteractiveTarget(e: Event): boolean {
  for (const node of e.composedPath()) {
    if (node instanceof HTMLElement && node.matches(INTERACTIVE)) return true;
  }
  return false;
}

const ICONS: Record<string, string> = {
  smallify:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 15 12 9 18 15"/></svg>',
  minimize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="19" x2="19" y2="19"/></svg>',
  maximize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="5" width="14" height="14" rx="1"/></svg>',
  normalize:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="4" width="12" height="12" rx="1"/><rect x="4" y="8" width="12" height="12" rx="1"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
};

/** Session-monotonic z counter. Never renormalized, so a panel's z-index is a
 * stable identity while it lives (jsPanel's resetZi() was not — see WINDOWS.md). */
let zSeq = 100;

/**
 * Next z-index, guaranteed above every panel currently in the DOM — including
 * jsPanel's own view-window panels, which carry the identical `.jsPanel` class
 * (deliberate contract compatibility, see the file header). Until Task 6
 * migrates view windows onto this shell, table panels (this module) and view
 * panels (jsPanel) keep SEPARATE creation-order counters; scanning the DOM
 * instead of trusting only the local `zSeq` keeps the two numberings mutually
 * comparable, so a freshly-created/fronted table panel can't end up
 * numerically behind an older view panel — which would let its invisible
 * resize-edge hotspots intercept clicks meant for that view.
 */
function nextZ(): number {
  let max = zSeq;
  for (const other of document.querySelectorAll<HTMLElement>('.jsPanel')) {
    const z = Number(other.style.zIndex);
    if (Number.isFinite(z) && z > max) max = z;
  }
  zSeq = max + 1;
  return zSeq;
}

/** Whether `el` already has the highest z-index among every panel in the DOM
 * (both registries — see `nextZ()`), i.e. fronting it would be a no-op. */
function isTopmost(el: HTMLElement): boolean {
  const mine = Number(el.style.zIndex);
  for (const other of document.querySelectorAll<HTMLElement>('.jsPanel')) {
    if (other !== el && Number(other.style.zIndex) > mine) return false;
  }
  return true;
}

const registry = new Set<PanelShellEl>();

/** Open panels, highest z first (matches jsPanel.getPanels()'s order). */
export function getPanels(): PanelShellEl[] {
  return [...registry].sort((a, b) => Number(b.style.zIndex) - Number(a.style.zIndex));
}

function btn(kind: keyof typeof ICONS, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `jsPanel-btn jsPanel-btn-${kind}`;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.innerHTML = ICONS[kind] ?? '';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export function createPanel(opts: PanelShellOptions): PanelShellEl {
  const el = document.createElement('div') as PanelShellEl;
  el.className = 'jsPanel';
  el.id = opts.id;
  el.style.setProperty('--eda-panel-color', opts.color ?? '#01579b');

  // Header: logo | titlebar(title) | controlbar(smallify min max normalize close)
  const hdr = document.createElement('div');
  hdr.className = 'jsPanel-hdr';
  const headerbar = document.createElement('div');
  headerbar.className = 'jsPanel-headerbar';
  const logo = document.createElement('div');
  logo.className = 'jsPanel-headerlogo';
  logo.innerHTML = opts.logo ?? '';
  const titlebar = document.createElement('div');
  titlebar.className = 'jsPanel-titlebar';
  // Focusable via pointer so tapping the header blurs (collapses) an open
  // search box; not in the tab order. The shell does not preventDefault on
  // pointerdown, so a real click's native focus-follows-click already lands
  // here — but a script-dispatched PointerEvent (e2e's `dispatchEvent`) never
  // triggers that native side effect, so focus it explicitly too.
  titlebar.tabIndex = -1;
  titlebar.style.outline = 'none'; // no focus ring on the drag bar
  titlebar.addEventListener('pointerdown', () => titlebar.focus());
  const title = document.createElement('span');
  title.className = 'jsPanel-title';
  title.textContent = opts.title;
  titlebar.append(title);
  const controlbar = document.createElement('div');
  controlbar.className = 'jsPanel-controlbar';
  controlbar.append(
    btn('smallify', 'Collapse', () => act('smallify')),
    btn('minimize', 'Minimize', () => act('minimize')),
    btn('maximize', 'Maximize', () => el.maximize()),
    btn('normalize', 'Restore', () => act('normalize')),
    btn('close', 'Close', () => el.close()),
  );
  headerbar.append(logo, titlebar, controlbar);
  hdr.append(headerbar);

  const contentHost = document.createElement('div');
  contentHost.className = 'jsPanel-content';
  contentHost.append(opts.content);

  const ftr = document.createElement('div');
  ftr.className = 'jsPanel-ftr';
  if (opts.footerToolbar) {
    ftr.classList.add('active');
    ftr.append(opts.footerToolbar);
  }

  el.append(hdr, contentHost, ftr);
  for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as Edge[]) {
    const z = document.createElement('div');
    z.className = 'eda-resize';
    z.dataset['edge'] = edge;
    el.append(z);
  }
  el.style.zIndex = String(nextZ());
  opts.container.append(el);

  // Size. panelSize is the total box (restores persist offsetWidth/Height);
  // contentSize describes the data area, so chrome heights are added after
  // mount (the append above makes offsetHeight readable).
  if (opts.panelSize) {
    el.style.width = `${opts.panelSize.w}px`;
    el.style.height = `${opts.panelSize.h}px`;
  } else {
    const c = opts.contentSize ?? { w: 720, h: 360 };
    el.style.width = `${c.w}px`;
    el.style.height = `${c.h + hdr.offsetHeight + ftr.offsetHeight}px`;
  }

  // Position (container-local layout coordinates; the canvas transform is visual only).
  const pos = opts.position ?? 'center';
  const pw = el.offsetWidth;
  const cw = opts.container.clientWidth;
  if (pos === 'center') {
    el.style.left = `${Math.max(0, (cw - pw) / 2)}px`;
    el.style.top = `${Math.max(0, (opts.container.clientHeight - el.offsetHeight) / 2)}px`;
  } else if ('centerTopOffset' in pos) {
    el.style.left = `${Math.max(0, (cw - pw) / 2)}px`;
    el.style.top = `${pos.centerTopOffset}px`;
  } else {
    el.style.left = `${pos.x}px`;
    el.style.top = `${pos.y}px`;
  }

  // ---- state + status plumbing ----------------------------------------
  let state = initialState(opts.boot);
  /** The normal-state rect, kept while minimized/maximized/smallified. */
  let normalRect: Rect = readRect();
  let bar: HTMLElement | null = null;
  let unsubViewport: (() => void) | null = null;
  let refitObserver: ResizeObserver | null = null;

  function readRect(): Rect {
    return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
  }
  function applyRect(r: Rect): void {
    el.style.left = `${r.x}px`;
    el.style.top = `${r.y}px`;
    el.style.width = `${r.w}px`;
    el.style.height = `${r.h}px`;
  }

  /** Size + counter-transform so the panel fills the VISIBLE overlay: the
   * container is CSS-transformed by pan/zoom, so the layout box alone is not
   * enough (this replaces maximize-fill.ts, kept formula and all). */
  function applyMaxFill(): void {
    const s = opts.viewport?.getState() ?? { x: 0, y: 0, scale: 1 };
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = `${opts.container.clientWidth}px`;
    el.style.height = `${opts.container.clientHeight}px`;
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${-s.x / s.scale}px, ${-s.y / s.scale}px) scale(${1 / s.scale})`;
  }

  function enterMaximized(): void {
    applyMaxFill();
    unsubViewport ??= opts.viewport?.subscribe(applyMaxFill) ?? null;
    if (!refitObserver && typeof ResizeObserver !== 'undefined') {
      // Re-fit when the canvas box changes (browser resize, header wrap) —
      // this replaces refit-panels.ts.
      refitObserver = new ResizeObserver(applyMaxFill);
      refitObserver.observe(opts.container);
    }
  }
  function exitMaximized(): void {
    unsubViewport?.();
    unsubViewport = null;
    refitObserver?.disconnect();
    refitObserver = null;
    el.style.transform = '';
    el.style.transformOrigin = '';
  }

  function makeBar(): HTMLElement {
    const b = document.createElement('div');
    b.className = 'jsPanel-replacement';
    b.id = `${opts.id}-min`;
    b.style.setProperty('--eda-panel-color', opts.color ?? '#01579b');
    const bLogo = document.createElement('div');
    bLogo.className = 'jsPanel-headerlogo';
    bLogo.innerHTML = logo.innerHTML;
    const bTitle = document.createElement('span');
    bTitle.className = 'jsPanel-title';
    bTitle.textContent = title.textContent;
    b.append(
      bLogo,
      bTitle,
      btn('normalize', 'Restore', () => act('normalize')),
      btn('close', 'Close', () => el.close()),
    );
    b.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button')) return;
      act('normalize');
    });
    return b;
  }

  /** Apply the DOM effects of leaving `from` for `state.status`. */
  function applyStatusDom(from: PanelStatus): void {
    if (from === 'maximized' && state.status !== 'maximized') exitMaximized();
    if (from === 'minimized' && state.status !== 'minimized') {
      bar?.remove();
      bar = null;
      el.style.display = '';
    }
    switch (state.status) {
      case 'minimized': {
        if (from === 'normalized') normalRect = readRect();
        // A smallified panel may have been dragged; keep its live x/y but the
        // pre-collapse w/h captured at smallify time.
        else if (from === 'smallified') normalRect = { ...normalRect, x: el.offsetLeft, y: el.offsetTop };
        // display:none instead of jsPanel's left:-9999 parking — the managers'
        // "-9000 sentinel" guards become dead code but stay harmless.
        el.style.display = 'none';
        const dock = opts.minimizeTo ? document.querySelector(opts.minimizeTo) : null;
        bar = makeBar();
        (dock ?? opts.container).append(bar);
        break;
      }
      case 'maximized':
        if (from === 'normalized') normalRect = readRect();
        else if (from === 'smallified') normalRect = { ...normalRect, x: el.offsetLeft, y: el.offsetTop };
        enterMaximized();
        break;
      case 'smallified':
        normalRect = readRect();
        el.style.height = `${hdr.offsetHeight}px`;
        break;
      case 'normalized':
        if (from === 'smallified') normalRect = { ...normalRect, x: el.offsetLeft, y: el.offsetTop };
        applyRect(normalRect);
        break;
      case 'closed':
        break;
    }
    el.dataset['status'] = state.status;
  }

  /** One state transition → one DOM settle → one onstatuschange. */
  function act(action: PanelAction): void {
    const prev = state;
    state = transition(state, action);
    if (state.status === prev.status) return;
    applyStatusDom(prev.status);
    opts.onstatuschange?.(el);
  }

  // ---- public element API (the instance IS the element) ----------------
  Object.defineProperty(el, 'status', { get: () => state.status });
  el.minimize = () => act('minimize');
  el.maximize = (_cb?: undefined, donotfront?: boolean) => {
    act('maximize');
    if (donotfront !== true) el.front();
  };
  el.normalize = () => act('normalize');
  el.smallify = () => act('smallify');
  el.front = (_cb?: undefined, execOnFrontedCallbacks?: boolean) => {
    el.style.zIndex = String(nextZ());
    if (execOnFrontedCallbacks !== false) opts.onfronted?.();
  };
  el.close = () => {
    if (state.status === 'closed') return;
    state = transition(state, 'close');
    bar?.remove();
    exitMaximized();
    registry.delete(el);
    el.remove();
    opts.onclosed?.();
  };
  el.setHeaderTitle = (t: string) => {
    title.textContent = t;
    const barTitle = bar?.querySelector('.jsPanel-title');
    if (barTitle) barTitle.textContent = t;
  };
  el.setHeaderLogo = (svg: string) => {
    logo.innerHTML = svg;
    const barLogo = bar?.querySelector('.jsPanel-headerlogo');
    if (barLogo) barLogo.innerHTML = svg;
  };
  el.persistFlags = () => persistFlags(state);
  registry.add(el);

  // ---- interactions ----------------------------------------------------
  // Any pointerdown inside the panel fronts it — but only when another panel
  // is actually on top. Fronting unconditionally on every pointerdown fired
  // `onfronted` (a store write — see stampFrontOrder in jspanel-manager.ts)
  // on every click anywhere in the content, including mid-drag on a data-table
  // column-resize handle: the resulting table-record update raced the
  // in-memory column-width freeze the resize was building, so an interior
  // click no longer just "focuses" the panel — a REAL front (z-order change)
  // still fires onfronted normally.
  el.addEventListener(
    'pointerdown',
    () => {
      if (!isTopmost(el)) el.front();
    },
    true,
  );

  // Drag by header, logo, and footer. Unclamped by design.
  const wireDrag = (handle: HTMLElement): void => {
    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (isInteractiveTarget(e)) return;
      if (state.status === 'maximized' || state.status === 'minimized') return;
      const startRect = readRect();
      const scale = opts.viewport?.getState().scale ?? 1;
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const onMove = (ev: PointerEvent): void => {
        moved = true;
        const r = dragRect(startRect, ev.clientX - sx, ev.clientY - sy, scale);
        el.style.left = `${r.x}px`;
        el.style.top = `${r.y}px`;
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        if (moved) opts.onmoved?.();
      };
      handle.setPointerCapture(e.pointerId);
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
  };
  wireDrag(titlebar);
  wireDrag(logo);
  wireDrag(ftr);

  // Resize from the edge/corner zones.
  for (const zone of el.querySelectorAll<HTMLElement>('.eda-resize')) {
    zone.addEventListener('pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (state.status !== 'normalized') return;
      const edge = zone.dataset['edge'] as Edge;
      const startRect = readRect();
      const scale = opts.viewport?.getState().scale ?? 1;
      const sx = e.clientX;
      const sy = e.clientY;
      let moved = false;
      const onMove = (ev: PointerEvent): void => {
        moved = true;
        applyRect(resizeRect(startRect, edge, ev.clientX - sx, ev.clientY - sy, scale, MIN_W, MIN_H));
      };
      const onUp = (): void => {
        zone.removeEventListener('pointermove', onMove);
        zone.removeEventListener('pointerup', onUp);
        zone.removeEventListener('pointercancel', onUp);
        if (moved) opts.onresized?.();
      };
      zone.setPointerCapture(e.pointerId);
      zone.addEventListener('pointermove', onMove);
      zone.addEventListener('pointerup', onUp);
      zone.addEventListener('pointercancel', onUp);
    });
  }

  // Double-click the header toggles maximize/restore (replaces panel-titlebar.ts).
  hdr.addEventListener('dblclick', (e: MouseEvent) => {
    if (isInteractiveTarget(e)) return;
    if (state.status === 'maximized') act('normalize');
    else el.maximize();
  });

  // Boot status. Applied synchronously and WITHOUT onstatuschange: this is the
  // initial state, not a change — the stored geometry already describes it, and
  // the caller has not registered the panel yet (jsPanel forced a
  // queueMicrotask dance here; we control init order, so none is needed).
  if (state.status !== 'normalized') {
    applyStatusDom('normalized');
  } else {
    el.dataset['status'] = 'normalized';
  }

  return el;
}
