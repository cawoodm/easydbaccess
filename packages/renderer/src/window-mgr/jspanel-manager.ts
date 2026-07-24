/**
 * jsPanel-backed window manager.
 *
 * Each Table in the current workspace is rendered as a floating, draggable,
 * resizable jsPanel containing a <data-table>. Geometry (x, y, w, h) is
 * persisted back to the Table record so windows restore on reload.
 *
 * Panels mount into document.body (jsPanel's default). The app-shell chrome
 * keeps a high z-index so it stays above panels even when they're dragged
 * toward the edges.
 *
 * Panels are draggable anywhere with no boundary clamping — they may sit
 * partly or wholly off-screen. That's intentional: the pan/zoom canvas
 * (touch pan on mobile, right-button drag on desktop) always brings a
 * stray panel back into view, so a hard containment box would only get in
 * the way.
 */

// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';
import 'jspanel4/es6module/jspanel.css';

import type { Table, WindowGeometry } from '@easydb/shared';
import { getContext, type AppContext } from '../app-context.js';
import { initPanZoom, type PanZoomHandle, type PanZoomState } from './panzoom.js';
import '../table/data-table.js';
import '../chrome/panel-search.js';
import '../chrome/panel-footer.js';

/** The element jsPanels mount into — the pan/zoom-transformed viewport. */
function panelContainer(): HTMLElement {
  return (
    document.getElementById('easydb-panels-viewport') ??
    document.getElementById('easydb-panels') ??
    document.body
  );
}

/**
 * Pin the panel overlay's top/bottom to the app-shell header/footer heights so
 * a maximized window fills exactly the space between them. The overlay's CSS
 * assumes a 48px chrome; this overrides it with the measured heights (which are
 * larger when the header wraps on a narrow window, or under browser zoom).
 */
function syncOverlayInsets(outer: HTMLElement): void {
  const root = document.querySelector('app-shell')?.shadowRoot;
  const header = root?.querySelector('header') as HTMLElement | null;
  const footer = root?.querySelector('footer') as HTMLElement | null;
  if (header) outer.style.top = `${header.offsetHeight}px`;
  if (footer) outer.style.bottom = `${footer.offsetHeight}px`;
}

/** jsPanel instance — typed loose since the lib ships no .d.ts. */
type Panel = {
  id: string;
  close(): void;
  minimize?: () => void;
  maximize?: () => void;
  setHeaderTitle?: (title: string) => void;
  status: 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
};

const panels = new Map<string, Panel>();
/**
 * Set of table ids whose close-confirmation has been resolved positively.
 * onbeforeclose short-circuits on a match so the user isn't asked twice.
 */
const confirmedClose = new Set<string>();
/**
 * Set of table ids whose panels are being closed because the table was
 * removed externally (json-import "Replace entire workspace", server/gist
 * pull). onclosed reads this to skip the cascade delete — the data is
 * already gone, and re-running deleteTableCascade is a redundant no-op
 * that also briefly logs storage-layer "not found" noise.
 */
const externallyClosed = new Set<string>();
let initialized = false;
/** Canvas pan/zoom control — reset while a window is maximized so it fills the screen. */
let panzoom: PanZoomHandle | null = null;

export async function initWindowManager(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const ctx = await getContext();

  // Pan/zoom over the whole table canvas: touch pan + pinch-zoom on mobile,
  // right-button drag pan on desktop. Both bring a stray (off-screen) panel
  // back into view now that panel dragging is unclamped.
  const outer = document.getElementById('easydb-panels');
  const viewport = document.getElementById('easydb-panels-viewport');
  if (outer && viewport) {
    panzoom = initPanZoom(outer, viewport);
    // Keep the panel overlay aligned to the REAL header/footer heights instead
    // of a hardcoded 48px. The header grows when its buttons wrap (narrow
    // windows) or with larger fonts/zoom; a stale offset left a maximized
    // window's titlebar tucked under the header. Re-sync on any header/footer
    // resize (wrap, plugin buttons) and on window resize.
    const sync = () => syncOverlayInsets(outer);
    sync();
    window.addEventListener('resize', sync);
    const shellRoot = document.querySelector('app-shell')?.shadowRoot;
    const header = shellRoot?.querySelector('header');
    const footer = shellRoot?.querySelector('footer');
    if (typeof ResizeObserver !== 'undefined' && (header || footer)) {
      const ro = new ResizeObserver(sync);
      if (header) ro.observe(header);
      if (footer) ro.observe(footer);
    }
  }

  // Initial population. Open in ascending saved-z order so jsPanel's internal
  // zi.next() counter reproduces the user's last layering — the panel that
  // was on top last session is opened last and ends up on top again.
  const tables = (await ctx.store.tables.find()).filter((t) => t.workspaceId === ctx.workspaceId);
  tables.sort(byAscendingZ);
  for (const t of tables) openPanel(t, ctx);

  // Reactive sync: open new tables' panels, close panels whose tables vanished.
  ctx.store.tables.subscribe((all) => {
    const inWs = all.filter((t) => t.workspaceId === ctx.workspaceId);
    const liveIds = new Set(inWs.map((t) => t.id));

    for (const [id, panel] of panels) {
      if (!liveIds.has(id)) {
        panels.delete(id);
        // The table was removed externally (e.g. json-import "Replace entire
        // workspace", server/gist pull). Mark the close as confirmed so
        // onbeforeclose doesn't pop a "Delete table?" prompt for data that's
        // already gone — and tell onclosed to skip its cascade delete.
        confirmedClose.add(id);
        externallyClosed.add(id);
        try {
          if (panel.status !== 'closed') panel.close();
        } catch {
          /* already gone */
        }
      }
    }
    const toOpen = inWs.filter((t) => !panels.has(t.id)).sort(byAscendingZ);
    for (const t of toOpen) openPanel(t, ctx);
  });
}

function byAscendingZ(a: Table, b: Table): number {
  return (a.windowGeometry?.z ?? -Infinity) - (b.windowGeometry?.z ?? -Infinity);
}

/** Minimum sensible panel dimensions; anything smaller is treated as corrupt. */
const MIN_W = 200;
const MIN_H = 100;
/** Default size for new (or sanity-reset) panels — matches contentSize below. */
const DEFAULT_W = 720;
const DEFAULT_H = 360;

/**
 * Validates persisted geometry, discarding only corrupt records.
 *
 * Returns null (→ caller falls back to defaults: cascade + 720x360) when `g`
 * is missing, has a non-finite field, or is smaller than the minimum sensible
 * size. Otherwise the geometry is returned verbatim — position is NOT clamped:
 * a panel may legitimately restore partly or fully off-screen, because the
 * pan/zoom canvas (touch pan / desktop right-drag) brings it back into view.
 */
function sanitizeGeometry(g: WindowGeometry | undefined): WindowGeometry | null {
  if (!g) return null;
  if (!Number.isFinite(g.w) || !Number.isFinite(g.h)) return null;
  if (!Number.isFinite(g.x) || !Number.isFinite(g.y)) return null;
  if (g.w < MIN_W || g.h < MIN_H) return null;
  return { ...g };
}

function openPanel(t: Table, ctx: AppContext): void {
  const panelId = `panel-${cssSafe(t.id)}`;
  const container = panelContainer();
  const g = sanitizeGeometry(t.windowGeometry);
  const startMinimized = g?.minimized === true;

  // The live <data-table> holds every row in memory, keeps a store subscription
  // open, and (for remote/live tables) fetches rows the moment it mounts. So we
  // mount it lazily: a window that opens minimized gets a bare placeholder and
  // fetches NOTHING until the user expands it — then a fresh grid mounts, shows
  // its progress bar, and loads. Minimizing later detaches the grid again
  // (releasing memory + stopping any polling).
  const makeGrid = (): HTMLElement => {
    const el = document.createElement('data-table');
    (el as HTMLElement & { tableId: string }).tableId = t.id;
    el.style.height = '100%';
    return el;
  };
  const content: HTMLElement = startMinimized ? document.createElement('div') : makeGrid();
  let contentEl: HTMLElement | null = startMinimized ? null : content;

  // Panel title row-count: "<name> (<count>)". Subscribing to rows triggers a
  // fetch for live/remote tables, so it is gated on the grid being mounted —
  // a minimized window keeps it STOPPED (fetches nothing) until it's expanded.
  let lastName = t.name;
  let rowCountUnsub: (() => void) | null = null;
  const updateTitle = (count: number) => {
    if (typeof panel.setHeaderTitle === 'function') {
      panel.setHeaderTitle(`${lastName} (${count})`);
    }
  };
  const startRowCount = (): void => {
    if (rowCountUnsub) return;
    rowCountUnsub = ctx.store.rows(t.id).subscribe((rows) => updateTitle(rows.length));
  };
  const stopRowCount = (): void => {
    rowCountUnsub?.();
    rowCountUnsub = null;
  };

  const unmountContent = (): void => {
    stopRowCount();
    (footer as HTMLElement & { active: boolean }).active = false;
    contentEl?.remove();
    contentEl = null;
  };
  const mountContent = (): void => {
    if (contentEl) return;
    const host = document
      .getElementById(panelId)
      ?.querySelector('.jsPanel-content') as HTMLElement | null;
    if (!host) return;
    host.replaceChildren(); // drop the minimized placeholder / any stale node
    const el = makeGrid();
    host.appendChild(el);
    contentEl = el;
    (footer as HTMLElement & { active: boolean }).active = true;
    startRowCount();
  };

  const search = document.createElement('panel-search');
  (search as HTMLElement & { tableId: string }).tableId = t.id;

  const footer = document.createElement('panel-footer');
  (footer as HTMLElement & { tableId: string }).tableId = t.id;
  // A minimized window's footer must not subscribe to rows (that fetches for a
  // live table); it's activated when the window is expanded (see mountContent).
  (footer as HTMLElement & { active: boolean }).active = !startMinimized;

  // Maximize must fill the visible area, but panels live inside the pan/zoom-
  // transformed canvas: jsPanel sizes a maximized panel to the viewport's
  // layout box (left:0, top:0, w/h = clientW/H) — correct in layout, but the
  // viewport's `translate()/scale()` then offsets and scales it visually, so a
  // panned or zoomed canvas leaves the "maximized" window adrift.
  //
  // Fix: give the maximized panel its own transform that exactly cancels the
  // canvas transform, so it stays pinned filling the overlay — and keep it in
  // sync as the canvas pans/zooms underneath. For canvas transform
  // translate(tx,ty) scale(s), the cancelling panel transform (origin 0 0) is
  // translate(-tx/s, -ty/s) scale(1/s): the panel's (0,0)-(W,H) box then maps
  // back to the overlay's (0,0)-(W,H) on screen. See panzoom.ts for the math.
  let maxUnsub: (() => void) | null = null;
  const applyMaxCounter = (s: PanZoomState): void => {
    const el = document.getElementById(panelId);
    if (!el) return;
    el.style.transformOrigin = '0 0';
    el.style.transform = `translate(${-s.x / s.scale}px, ${-s.y / s.scale}px) scale(${1 / s.scale})`;
  };
  const enterMaximizedFill = (): void => {
    if (maxUnsub || !panzoom) return;
    applyMaxCounter(panzoom.snapshot());
    maxUnsub = panzoom.subscribe(applyMaxCounter);
  };
  const exitMaximizedFill = (): void => {
    maxUnsub?.();
    maxUnsub = null;
    const el = document.getElementById(panelId);
    if (el) {
      el.style.transform = '';
      el.style.transformOrigin = '';
    }
  };

  const position = g
    ? { my: 'left-top', at: 'left-top', offsetX: g.x, offsetY: g.y }
    : nextCascadePosition();

  // Saved g.w/g.h come from offsetWidth/Height (total panel size including
  // chrome), so restore via panelSize. New panels use contentSize so the
  // default 720x360 describes the data area, not the chrome.
  const sizeOpt = g ? { panelSize: `${g.w} ${g.h}` } : { contentSize: `${DEFAULT_W} ${DEFAULT_H}` };

  const panel = jsPanel.create({
    id: panelId,
    container,
    headerTitle: t.name,
    footerToolbar: footer,
    // Default jsPanel controls; smallify (compact-header mode) is useful so
    // we keep it enabled. min/max/normalize/close are all on by default.
    theme: 'primary',
    content,
    ...sizeOpt,
    position,
    // Dock minimized windows into our fixed bottom-left dock (a child of the
    // untransformed overlay), NOT the pan/zoom viewport — so they stay pinned
    // there while the canvas is panned/zoomed. jsPanel appends the minimized
    // replacement bar into this selector.
    minimizeTo: '#easydb-minimized-dock',
    // No containment and no per-frame drag clamp: panels drag (and resize)
    // freely to any position, including off-screen. `containment: false`
    // disables jsPanel's own boundary box; we deliberately don't re-clamp in
    // a `drag` handler. The pan/zoom canvas (touch pan / desktop right-drag)
    // is the way to bring a stray panel back into view.
    dragit: {
      containment: false,
      stop: () => saveGeometry(t.id, ctx),
    },
    resizeit: { containment: false, stop: () => saveGeometry(t.id, ctx) },
    // Fires when the panel is focused/brought-to-front by any means
    // (click on chrome, click on content, programmatic .front()). We can't
    // trust el.style.zIndex here — jsPanel calls resetZi() inside front(),
    // which renormalizes all panel z-indexes to a contiguous 100..N range,
    // so the fronted panel always ends up at "max" (same value every time).
    // Use a wall-clock timestamp as the saved z instead: higher = more
    // recently fronted, and boot sorts by ascending z to restore the order.
    onfronted: () => stampFrontOrder(t.id, ctx),
    // jsPanel onbeforeclose can't await, so we use a two-step pattern: first
    // close attempt opens our async confirm dialog and returns false to cancel
    // the close. If the user confirms, we set a flag and re-call panel.close,
    // which short-circuits this guard and lets jsPanel proceed to onclosed.
    onbeforeclose: () => {
      if (confirmedClose.has(t.id)) return true;
      void (async () => {
        const yes = await ctx.api.ui.dialogs.confirm(
          t.source
            ? `Remove the live table "${t.name}"? Its data stays on the Datasette server.`
            : `Delete table "${t.name}" and all its rows?`,
          'Confirm',
        );
        if (yes) {
          confirmedClose.add(t.id);
          panels.get(t.id)?.close();
        }
      })();
      return false;
    },
    onclosed: async () => {
      panels.delete(t.id);
      confirmedClose.delete(t.id);
      // Skip the cascade delete when the table was removed externally
      // (subscription-driven close) — the deletion has already been done.
      if (externallyClosed.delete(t.id)) return;
      await deleteTableCascade(t.id, ctx);
    },
    // Unload the data-table when minimized; remount it (fresh, re-reading the
    // store) when the panel returns to a normal or maximized state. jsPanel
    // reports the new status on the panel instance it passes here (there is no
    // `data-status` attribute to read off the DOM).
    onstatuschange: (p: Panel) => {
      if (p.status === 'minimized') unmountContent();
      else if (p.status === 'normalized' || p.status === 'maximized') mountContent();
      if (p.status === 'maximized') enterMaximizedFill();
      else exitMaximizedFill();
      void saveGeometry(t.id, ctx);
    },
  }) as Panel;

  panels.set(t.id, panel);

  // Inject the per-table search into the controlbar (right side of the title
  // row, next to min/max/close) so it shares the title bar instead of taking
  // a second header strip — matches the minniDBMax v1 layout.
  const panelEl = document.getElementById(panelId);
  const controlbar = panelEl?.querySelector('.jsPanel-controlbar');
  if (controlbar) controlbar.prepend(search);

  // Make the header/titlebar focusable so tapping it takes focus away from any
  // open search box (per-table or the global header search) — collapsing it.
  // jsPanel calls preventDefault on the titlebar's pointerdown (for dragging),
  // which suppresses the default focus shift, so we focus it explicitly.
  const titlebar = panelEl?.querySelector('.jsPanel-titlebar') as HTMLElement | null;
  if (titlebar) {
    titlebar.tabIndex = -1; // focusable via script/pointer, not in tab order
    titlebar.style.outline = 'none'; // no focus ring on the drag bar
    titlebar.addEventListener('pointerdown', () => titlebar.focus());
  }

  // Restore minimized/maximized state. Defer to next tick so jsPanel's own
  // init (centering, sizing) finishes before we drive a state change.
  if (g?.maximized && typeof panel.maximize === 'function') {
    queueMicrotask(() => panel.maximize?.());
  } else if (g?.minimized && typeof panel.minimize === 'function') {
    queueMicrotask(() => panel.minimize?.());
  }

  // Track name changes for the title (cheap — this does NOT fetch rows).
  void ctx.store.tables.subscribe((all) => {
    const cur = all.find((x) => x.id === t.id);
    if (cur && cur.name !== lastName) {
      lastName = cur.name;
      if (rowCountUnsub)
        void ctx.store
          .rows(t.id)
          .find()
          .then((r) => updateTitle(r.length));
    }
  });

  // Start the live row-count only when the window opens with a grid mounted.
  // A window restored minimized starts it later, on expand (see mountContent).
  if (!startMinimized) startRowCount();

  // Clean up the row subscription on close so it doesn't leak after table delete.
  const origClose = panel.close.bind(panel);
  panel.close = () => {
    stopRowCount();
    return origClose();
  };
}

let cascadeIdx = 0;
function nextCascadePosition(): { my: string; at: string; offsetX: number; offsetY: number } {
  const i = cascadeIdx++;
  return {
    my: 'left-top',
    at: 'left-top',
    offsetX: 40 + (i % 8) * 30,
    offsetY: 80 + (i % 8) * 30,
  };
}

async function saveGeometry(tableId: string, ctx: AppContext): Promise<void> {
  const el = document.getElementById(`panel-${cssSafe(tableId)}`);
  if (!el) return;
  // jsPanel keeps the status on the panel instance, not a DOM attribute.
  const status = panels.get(tableId)?.status ?? 'normalized';
  try {
    const t = await ctx.store.tables.findOne(tableId);
    const prev = t?.windowGeometry;
    const minimized = status === 'minimized';
    const maximized = status === 'maximized';
    let x = el.offsetLeft;
    let y = el.offsetTop;
    let w = el.offsetWidth;
    let h = el.offsetHeight;
    // While minimized jsPanel parks the panel at left:-9999; while maximized it
    // fills the container. In neither state does the live rect describe the
    // panel's normal geometry, so keep the last-stored rect instead. The
    // sentinel guard also covers the rare first-ever save while minimized.
    if ((minimized || maximized) && prev) {
      x = prev.x;
      y = prev.y;
      w = prev.w;
      h = prev.h;
    }
    if (x <= -9000) x = prev?.x ?? 40;
    const geom: WindowGeometry = {
      x,
      y,
      w,
      h,
      // Preserve the front-order timestamp written by stampFrontOrder.
      // We can't read DOM z meaningfully — jsPanel renormalizes it on every
      // .front() so it's not a stable per-panel identity.
      z: prev?.z ?? 0,
      minimized,
      maximized,
    };
    await ctx.store.tables.patch(tableId, {
      windowGeometry: geom,
      updatedAt: Date.now(),
    });
  } catch {
    // Table might have just been deleted — ignore.
  }
}

/**
 * Save a "front rank" — Date.now() — into windowGeometry.z. We don't read the
 * DOM zIndex (jsPanel renormalizes it on every front() so all panels would
 * show the same max), and we don't try to save all panels in a batch — each
 * front fires once and the relative ordering follows from timestamps.
 */
async function stampFrontOrder(tableId: string, ctx: AppContext): Promise<void> {
  try {
    const t = await ctx.store.tables.findOne(tableId);
    if (!t) return;
    const geom = t.windowGeometry ?? {
      x: 0,
      y: 0,
      w: 720,
      h: 360,
      z: 0,
      minimized: false,
      maximized: false,
    };
    await ctx.store.tables.patch(tableId, {
      windowGeometry: { ...geom, z: Date.now() },
      updatedAt: Date.now(),
    });
  } catch {
    /* table may have just been deleted — ignore */
  }
}

async function deleteTableCascade(tableId: string, ctx: AppContext): Promise<void> {
  // Source-backed tables (e.g. a live Datasette connection) keep their rows on
  // the remote, not in the local store — `rows(tableId)` routes to the remote
  // provider. We must NOT cascade row-deletes there: it would issue remote
  // DELETEs (or, for a read-only connection, throw SourceReadOnlyError before
  // `tables.remove` runs — leaving the table behind so its panel reappears).
  // Closing the window just drops the local Table record (disconnects).
  const table = await ctx.store.tables.findOne(tableId);
  if (!table?.source) {
    const rowColl = ctx.store.rows(tableId);
    const rows = await rowColl.find();
    await rowColl.bulkRemove(rows.map((r) => r.id));
  }
  await ctx.store.tables.remove(tableId);
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
