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
import { openTableInfoDialog } from '../dialogs/table-info-dialog.js';
import { initPanZoom, type PanZoomHandle } from './panzoom.js';
import { createMaximizeFill } from './maximize-fill.js';
import { startMaximizedRefit } from './refit-panels.js';
import { startTitlebarBehavior } from './panel-titlebar.js';
import { countSuffix, VISIBLE_COUNT_EVENT, type VisibleCountDetail } from './panel-title.js';
import { sanitizeGeometry } from './geometry.js';
import '../table/data-table.js';
import '../chrome/panel-search.js';
import '../chrome/panel-footer.js';

/** The panel window title: the optional display `title`, else the technical `name`. */
function displayName(t: Table): string {
  return t.title?.trim() ? t.title.trim() : t.name;
}

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
  front?: () => void;
  minimize?: () => void;
  maximize?: () => void;
  setHeaderTitle?: (title: string) => void;
  status: 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
};

const panels = new Map<string, Panel>();
/**
 * Set of table ids whose panels are being closed programmatically — because the
 * table was removed (delete / json-import "Replace entire workspace" / server/
 * gist pull) or hidden from another tab. onclosed reads this to skip its
 * default hide-on-close side-effect: the store already reflects the intent.
 */
const externallyClosed = new Set<string>();
let initialized = false;
/** Canvas pan/zoom control. Exposed so view windows can share the same handle
 * to keep a maximized view filling the screen through pan/zoom. */
let panzoom: PanZoomHandle | null = null;

/** The live canvas pan/zoom handle, or null before the window manager inits. */
export function currentPanZoom(): PanZoomHandle | null {
  return panzoom;
}

/**
 * Brings a table's window to the front (restoring it first if minimized).
 * Used by the command palette's "Go to <table>" commands. Returns false when
 * no panel exists for that table id.
 */
export function focusTableWindow(tableId: string): boolean {
  const p = panels.get(tableId) as (Panel & { normalize?: () => void }) | undefined;
  if (p) {
    if (p.status === 'minimized') p.normalize?.();
    p.front?.();
    return true;
  }
  // No panel — the table is hidden (windowGeometry.closed). Un-hide it; the
  // store subscription then opens (and fronts) its panel.
  void unhideTable(tableId);
  return true;
}

/** Clear a table's `closed` flag so the subscription reopens its window. */
async function unhideTable(tableId: string): Promise<void> {
  const ctx = await getContext();
  const t = await ctx.store.tables.findOne(tableId);
  if (!t?.windowGeometry?.closed) return;
  await ctx.store.tables.patch(tableId, {
    windowGeometry: { ...t.windowGeometry, closed: false },
    updatedAt: Date.now(),
  });
}

/**
 * Permanently delete a table and its local rows (source-backed tables keep
 * their rows on the remote). Exposed for the delete-table plugin's trash
 * action; the store subscription closes the panel when the record vanishes.
 */
export async function deleteTable(tableId: string): Promise<void> {
  const ctx = await getContext();
  await deleteTableCascade(tableId, ctx);
}

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
    // A maximized panel is sized once from the container, so it must be re-fit
    // when the window (or the overlay's header/footer inset) changes size —
    // otherwise it overflows or under-fills the new canvas. Covers table AND
    // view windows; minimized panels ride the fixed dock and need nothing.
    startMaximizedRefit(viewport);
  }

  // Titlebar behavior jsPanel lacks: double-click to maximize / restore, and a
  // pointer (not move) cursor while maximized, since a maximized panel can't be
  // dragged. Delegated on the document, so table AND view windows are covered.
  startTitlebarBehavior();

  // Initial population. Open in ascending saved-z order so jsPanel's internal
  // zi.next() counter reproduces the user's last layering — the panel that
  // was on top last session is opened last and ends up on top again.
  const tables = (await ctx.store.tables.find()).filter((t) => t.workspaceId === ctx.workspaceId);
  tables.sort(byAscendingZ);
  for (const t of tables) if (!t.windowGeometry?.closed) openPanel(t, ctx);

  // Reactive sync: open new/reopened tables' panels; close panels whose tables
  // vanished (deleted) OR were hidden (windowGeometry.closed set here or in
  // another tab).
  ctx.store.tables.subscribe((all) => {
    const inWs = all.filter((t) => t.workspaceId === ctx.workspaceId);
    const byId = new Map(inWs.map((t) => [t.id, t]));

    for (const [id, panel] of panels) {
      const t = byId.get(id);
      if (!t || t.windowGeometry?.closed) {
        panels.delete(id);
        // Programmatic close: the table was removed (delete / json-import
        // "Replace entire workspace" / server/gist pull) or hidden elsewhere.
        // Tell onclosed to skip its default hide-on-close side-effect — the
        // store already reflects the intended state.
        externallyClosed.add(id);
        try {
          if (panel.status !== 'closed') panel.close();
        } catch {
          /* already gone */
        }
      }
    }
    const toOpen = inWs
      .filter((t) => !panels.has(t.id) && !t.windowGeometry?.closed)
      .sort(byAscendingZ);
    for (const t of toOpen) openPanel(t, ctx);
  });

  // A bulk pull (gist / server-sync) inserts tables one at a time, so the
  // reactive `subscribe` above opens each panel in insertion order, not saved-z
  // order (liveQuery fires per write, defeating its sort). After such a pull the
  // gist plugin dispatches `easydb:restack-windows`; re-front every open,
  // non-minimized panel in ascending-z order to restore the layering. liveQuery
  // opens panels asynchronously, so retry until all expected panels exist.
  document.addEventListener('easydb:restack-windows', () => {
    let attempts = 0;
    const restack = async (): Promise<void> => {
      const ordered = (await ctx.store.tables.find())
        .filter((t) => t.workspaceId === ctx.workspaceId && !t.windowGeometry?.minimized)
        .sort(byAscendingZ);
      if (attempts < 12 && !ordered.every((t) => panels.has(t.id))) {
        attempts++;
        setTimeout(() => void restack(), 80);
        return;
      }
      for (const t of ordered) {
        try {
          panels.get(t.id)?.front?.();
        } catch {
          /* panel closed mid-restack */
        }
      }
    };
    void restack();
  });
}

function byAscendingZ(a: Table, b: Table): number {
  return (a.windowGeometry?.z ?? -Infinity) - (b.windowGeometry?.z ?? -Infinity);
}

/** Default size for new (or sanity-reset) panels — matches contentSize below. */
const DEFAULT_W = 720;
const DEFAULT_H = 360;

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

  // Panel title row-count: "<name> (<count>)", or "<name> (<visible>/<total>)"
  // while a search/filter narrows the set. The mounted <data-table> owns the
  // visible-row computation (per-column filters + local + global search) and
  // emits it; we mirror that into the titlebar. A minimized window has no grid
  // and so no count events — the title shows the bare name until it's expanded.
  let lastTitle = displayName(t);
  let lastCount = -1;
  let lastTotal = -1;
  const renderTitle = (): void => {
    if (typeof panel.setHeaderTitle === 'function') {
      panel.setHeaderTitle(lastTitle + countSuffix(lastCount, lastTotal));
    }
  };
  const onVisibleCount = (e: Event): void => {
    const d = (e as CustomEvent<VisibleCountDetail>).detail;
    if (d.key !== t.id) return;
    lastCount = d.count;
    lastTotal = d.total;
    renderTitle();
  };
  document.addEventListener(VISIBLE_COUNT_EVENT, onVisibleCount as EventListener);

  const unmountContent = (): void => {
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
  };

  const search = document.createElement('panel-search');
  (search as HTMLElement & { tableId: string }).tableId = t.id;

  const footer = document.createElement('panel-footer');
  (footer as HTMLElement & { tableId: string }).tableId = t.id;
  // A minimized window's footer must not subscribe to rows (that fetches for a
  // live table); it's activated when the window is expanded (see mountContent).
  (footer as HTMLElement & { active: boolean }).active = !startMinimized;

  // A maximized panel must stay filling the visible overlay even though panels
  // live inside the pan/zoom-transformed canvas. The shared helper counters the
  // canvas transform on the panel and keeps it in sync on every pan/zoom.
  const maxFill = createMaximizeFill(panelId, () => panzoom);

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
    headerTitle: lastTitle,
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
    // Closing the window HIDES the table (keeps its data) rather than deleting
    // it — no confirm needed. It's reopened from the command palette
    // ("Go to <table>"); the delete-table button is the only path that removes
    // data. Hiding happens in onclosed so it also covers jsPanel's own controls.
    onclosed: async () => {
      panels.delete(t.id);
      // Programmatic close (table deleted/replaced/pulled, or hidden from
      // another tab) — the store already reflects the intended state, so don't
      // re-hide it.
      if (externallyClosed.delete(t.id)) return;
      // User closed the window: persist it as hidden, preserving geometry.
      const cur = await ctx.store.tables.findOne(t.id);
      if (!cur) return;
      const geom = cur.windowGeometry ?? {
        x: 60,
        y: 60,
        w: 720,
        h: 360,
        z: 1,
        minimized: false,
        maximized: false,
      };
      await ctx.store.tables.patch(t.id, {
        windowGeometry: { ...geom, closed: true },
        updatedAt: Date.now(),
      });
    },
    // Unload the data-table when minimized; remount it (fresh, re-reading the
    // store) when the panel returns to a normal or maximized state. jsPanel
    // reports the new status on the panel instance it passes here (there is no
    // `data-status` attribute to read off the DOM).
    onstatuschange: (p: Panel) => {
      if (p.status === 'minimized') unmountContent();
      else if (p.status === 'normalized' || p.status === 'maximized') mountContent();
      if (p.status === 'maximized') maxFill.enter();
      else maxFill.exit();
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

  // (i) info button in the titlebar — shown only when the table carries
  // descriptive metadata (Datasette description / source / license / about),
  // which lands asynchronously after a connect/import, so it's toggled
  // reactively as the table record updates.
  let curTable: Table | null = null;
  const infoBtn = document.createElement('button');
  infoBtn.type = 'button';
  infoBtn.title = 'Table info';
  infoBtn.setAttribute('aria-label', 'Table info');
  infoBtn.className = 'eda-info-btn';
  infoBtn.textContent = 'ⓘ';
  infoBtn.style.cssText =
    'display:none;background:none;border:0;color:inherit;cursor:pointer;font-size:1rem;line-height:1;padding:0 0.3rem;';
  infoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!curTable) return;
    openTableInfoDialog(lastTitle, curTable.info ?? {}, {
      source: curTable.source,
      origin: curTable.origin,
    });
  });
  controlbar?.prepend(infoBtn);
  const updateInfoBtn = (table?: Table | null): void => {
    curTable = table ?? null;
    // Show the button when there's descriptive metadata OR a provenance worth
    // explaining (imported snapshot / live connection).
    const has = !!(table?.info || table?.source || table?.origin);
    infoBtn.style.display = has ? 'inline-flex' : 'none';
  };
  updateInfoBtn(t);

  // Restore minimized/maximized state. Defer to next tick so jsPanel's own
  // init (centering, sizing) finishes before we drive a state change.
  if (g?.maximized && typeof panel.maximize === 'function') {
    queueMicrotask(() => panel.maximize?.());
  } else if (g?.minimized && typeof panel.minimize === 'function') {
    queueMicrotask(() => panel.minimize?.());
  }

  // Track name changes for the title and info-metadata arrival (cheap — this
  // does NOT fetch rows).
  void ctx.store.tables.subscribe((all) => {
    const cur = all.find((x) => x.id === t.id);
    if (!cur) return;
    updateInfoBtn(cur);
    if (displayName(cur) !== lastTitle) {
      lastTitle = displayName(cur);
      renderTitle();
    }
  });

  // Clean up the count listener on close so it doesn't leak after table delete.
  const origClose = panel.close.bind(panel);
  panel.close = () => {
    document.removeEventListener(VISIBLE_COUNT_EVENT, onVisibleCount as EventListener);
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
 * Monotonic front-rank source. `Date.now()` alone COLLIDES when several panels
 * are fronted within the same millisecond (a bulk restack, or panels opened
 * back-to-back), tying their `z` — and a tie loses the stacking order on the
 * next reload/pull (the sort can't tell them apart). This counter only ever
 * increases, so every stamp is unique and strictly ordered while still tracking
 * wall-clock time for cross-session comparisons.
 */
let lastFrontZ = 0;
function nextFrontZ(): number {
  lastFrontZ = Math.max(Date.now(), lastFrontZ + 1);
  return lastFrontZ;
}

/**
 * Save a "front rank" into windowGeometry.z. We don't read the DOM zIndex
 * (jsPanel renormalizes it on every front() so all panels would show the same
 * max), and we don't try to save all panels in a batch — each front fires once
 * and the relative ordering follows from the strictly-increasing rank.
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
      windowGeometry: { ...geom, z: nextFrontZ() },
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
