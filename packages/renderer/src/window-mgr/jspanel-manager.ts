/**
 * Table window manager, running on the in-repo panel shell (`panel-shell.ts`).
 *
 * Each Table in the current workspace is rendered as a floating, draggable,
 * resizable panel containing a <data-table>. Geometry (x, y, w, h) is
 * persisted back to the Table record so windows restore on reload.
 *
 * Panels mount into the pan/zoom-transformed canvas viewport (see
 * `panelContainer()`). The app-shell chrome keeps a high z-index so it stays
 * above panels even when they're dragged toward the edges.
 *
 * Panels are draggable anywhere with no boundary clamping — they may sit
 * partly or wholly off-screen. That's intentional: the pan/zoom canvas
 * (touch pan on mobile, right-button drag on desktop) always brings a
 * stray panel back into view, so a hard containment box would only get in
 * the way.
 */

import type { Table, WindowGeometry } from '@easydb/shared';
import { getContext, type AppContext } from '../app-context.js';
import { openTableInfoDialog } from '../dialogs/table-info-dialog.js';
import { initPanZoom, type PanZoomHandle } from './panzoom.js';
import { createPanel, type PanelShellEl, type ShellViewport } from './panel-shell/panel-shell.js';
import { queueGeometryWrite } from './geometry-writes.js';
import { countSuffix, VISIBLE_COUNT_EVENT, type VisibleCountDetail } from './panel-title.js';
import { sanitizeGeometry, byAscendingZ } from './geometry.js';
import { tableKind, isRefreshable, TABLE_KIND_ICONS } from './table-kind.js';
import { nextFrontZ } from './front-order.js';
import { registerPanel, unregisterPanel } from './panel-registry.js';
import { initRestack } from './restack.js';
import { FORCE_MINIMIZED } from './boot-flags.js';

// Re-exported so existing importers of this module keep working.
export { FORCE_MINIMIZED };
import '../table/data-table.js';
import '../chrome/panel-search.js';
import '../chrome/panel-footer.js';

/** The panel window title: the optional display `title`, else the technical `name`. */
function displayName(t: Table): string {
  return t.title?.trim() ? t.title.trim() : t.name;
}

/** The element panels mount into — the pan/zoom-transformed viewport. */
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

const panels = new Map<string, PanelShellEl>();
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

/** Pan/zoom hook handed to every shell panel: scale-aware dragging and the
 * maximize counter-transform both read it. Tolerates a not-yet-initialized
 * panzoom (unit boots, view manager races). */
export function shellViewport(): ShellViewport {
  return {
    getState: () => currentPanZoom()?.snapshot() ?? { x: 0, y: 0, scale: 1 },
    subscribe: (cb) => currentPanZoom()?.subscribe(cb) ?? (() => {}),
  };
}

/**
 * Brings a table's window to the front (restoring it first if minimized).
 * Used by the command palette's "Go to <table>" commands. Returns false when
 * no panel exists for that table id.
 */
/**
 * Persist every open table panel's current rect. Tile/Cascade move panels by
 * writing inline styles, which no jsPanel callback reports, so without this the
 * arranged layout was lost on the next reload (the stored rect still described
 * where the window sat before). Called by the bulk window commands.
 */
export async function persistTablePanelGeometry(): Promise<void> {
  const ctx = await getContext();
  await Promise.all([...panels.keys()].map((id) => saveGeometry(id, ctx)));
}

export function focusTableWindow(tableId: string): boolean {
  const p = panels.get(tableId);
  if (p) {
    if (p.status === 'minimized') p.normalize();
    p.front();
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
  }

  // Initial population. Open in ascending saved-z order so the panel-shell's
  // session z-counter reproduces the user's last layering — the panel that
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
        unregisterPanel(id);
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
  // order (liveQuery fires per write, defeating its sort) — and the same is
  // true across kinds at plain boot (tables always open before views; see
  // `table-list.ts`). `initRestack()` wires the `easydb:restack-windows`
  // listener (fired by gist-sync/json-import after a bulk pull) and runs one
  // merged table+view restack pass immediately, covering the boot case too.
  void initRestack();
}

/** Default size for new (or sanity-reset) panels — matches contentSize below. */
const DEFAULT_W = 720;
const DEFAULT_H = 360;

function openPanel(t: Table, ctx: AppContext): void {
  const panelId = `panel-${cssSafe(t.id)}`;
  const container = panelContainer();
  const g = sanitizeGeometry(t.windowGeometry);
  const startMinimized = FORCE_MINIMIZED || g?.minimized === true;

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
    panel.setHeaderTitle(lastTitle + countSuffix(lastCount, lastTotal));
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

  // Closing the window HIDES the table (keeps its data) rather than deleting
  // it — no confirm needed. It's reopened from the command palette
  // ("Go to <table>"); the delete-table button is the only path that removes
  // data.
  const onPanelClosed = async (): Promise<void> => {
    document.removeEventListener(VISIBLE_COUNT_EVENT, onVisibleCount as EventListener);
    panels.delete(t.id);
    unregisterPanel(t.id);
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
  };

  const panel = createPanel({
    id: panelId,
    container,
    title: lastTitle,
    logo: TABLE_KIND_ICONS[tableKind(t)],
    color: '#01579b', // jsPanel's old 'primary' theme color
    content,
    footerToolbar: footer,
    // Saved g.w/g.h come from offsetWidth/Height (total panel size incl.
    // chrome), so restores use panelSize; new panels size the data area.
    ...(g
      ? { panelSize: { w: g.w, h: g.h }, position: { x: g.x, y: g.y } }
      : { contentSize: { w: DEFAULT_W, h: DEFAULT_H }, position: nextCascadePosition() }),
    minimizeTo: '#easydb-minimized-dock',
    viewport: shellViewport(),
    // ?minimize wins over a saved maximized state — nothing loads rows on boot.
    boot: { minimized: startMinimized, maximized: !FORCE_MINIMIZED && g?.maximized === true },
    onmoved: () => void saveGeometry(t.id, ctx),
    onresized: () => void saveGeometry(t.id, ctx),
    // Stamp a monotonic front rank; DOM z stays stable in the shell but the
    // persisted rank must survive reloads and merge with views (front-order.ts).
    onfronted: () => void stampFrontOrder(t.id, ctx),
    onstatuschange: (p) => {
      if (p.status === 'minimized') unmountContent();
      else if (p.status === 'normalized' || p.status === 'maximized') mountContent();
      void saveGeometry(t.id, ctx);
    },
    onclosed: () => void onPanelClosed(),
  });

  panels.set(t.id, panel);
  // Registered so the global restack (`restack.ts`) can front this panel
  // without importing this module directly — see `panel-registry.ts`. The
  // `false` suppresses the shell's `onfronted`, so a restack does NOT re-stamp
  // the front rank it is itself ordering by.
  registerPanel(t.id, () => panel.front(undefined, false));

  // Inject the per-table search into the controlbar (right side of the title
  // row, next to min/max/close) so it shares the title bar instead of taking
  // a second header strip — matches the minniDBMax v1 layout.
  const panelEl = document.getElementById(panelId);
  const controlbar = panelEl?.querySelector('.jsPanel-controlbar');
  if (controlbar) controlbar.prepend(search);

  // Refreshable tables (source- or origin-backed) get a distinct panel colour
  // (see index.html's `.eda-refreshable` rule) — every kind except `normal`.
  if (isRefreshable(t)) panelEl?.classList.add('eda-refreshable');

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

  // A table's kind (normal/imported/referenced/connected) can change at
  // runtime — e.g. a plain table gains an `origin` after an import, or a
  // `source` after a live connect — so the titlebar icon and refreshable
  // colour must react too, exactly like the title does below.
  let lastKind = tableKind(t);

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
    const kind = tableKind(cur);
    if (kind !== lastKind) {
      lastKind = kind;
      panel.setHeaderLogo(TABLE_KIND_ICONS[kind]);
      panelEl?.classList.toggle('eda-refreshable', isRefreshable(cur));
    }
  });
}

let cascadeIdx = 0;
function nextCascadePosition(): { x: number; y: number } {
  const i = cascadeIdx++;
  return { x: 40 + (i % 8) * 30, y: 80 + (i % 8) * 30 };
}

function saveGeometry(tableId: string, ctx: AppContext): Promise<void> {
  // Serialized against stampFrontOrder: both patch the whole geometry object.
  return queueGeometryWrite(`table:${tableId}`, () => writeGeometry(tableId, ctx));
}

async function writeGeometry(tableId: string, ctx: AppContext): Promise<void> {
  const el = document.getElementById(`panel-${cssSafe(tableId)}`);
  if (!el) return;
  const shell = panels.get(tableId);
  const status = shell?.status ?? 'normalized';
  const flags = shell?.persistFlags() ?? { minimized: false, maximized: false };
  try {
    const t = await ctx.store.tables.findOne(tableId);
    const prev = t?.windowGeometry;
    // Under ?minimize the minimized/maximized state is a view override — keep
    // whatever was saved (see WINDOWS.md).
    const minimized = FORCE_MINIMIZED ? (prev?.minimized ?? false) : flags.minimized;
    const maximized = FORCE_MINIMIZED ? (prev?.maximized ?? false) : flags.maximized;
    let x = el.offsetLeft;
    let y = el.offsetTop;
    let w = el.offsetWidth;
    let h = el.offsetHeight;
    // While minimized the shell sets display:none (no longer the old
    // left:-9999 parking); while maximized it fills the container. In neither
    // state does the live rect describe the panel's normal geometry, so keep
    // the last-stored rect instead. The sentinel guard below is now dead code
    // (nothing parks off-screen at that x anymore) but stays harmless.
    //
    // Key off the LIVE status, not the flags above: under `?minimize` those
    // flags carry the saved values, but the panel really is parked (hidden),
    // so reading its rect would write x/y/w/h of a hidden window.
    const parked = status === 'minimized' || status === 'maximized';
    if (parked) {
      if (prev) {
        x = prev.x;
        y = prev.y;
        w = prev.w;
        h = prev.h;
      } else {
        // Nothing stored yet (e.g. a fresh panel maximized before it was ever
        // saved normalized) — there's no honest rect to record, but the
        // minimized/maximized FLAGS still must land, so fall back to the same
        // placeholder rect writeFrontOrder uses rather than dropping the write
        // entirely (that silently lost the flags whenever this was the very
        // first geometry write for a panel).
        x = 0;
        y = 0;
        w = DEFAULT_W;
        h = DEFAULT_H;
      }
    }
    if (x <= -9000) x = prev?.x ?? 40;
    const geom: WindowGeometry = {
      x,
      y,
      w,
      h,
      // Preserve the front-order timestamp written by stampFrontOrder.
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
 * Save a "front rank" into windowGeometry.z. The shell's own DOM z-index is
 * session-monotonic (never renormalized — see panel-shell.ts) but resets on
 * every reload, so it can't be persisted directly; each front fires once and
 * the relative ordering follows from the strictly-increasing rank instead.
 * `nextFrontZ()` (`front-order.ts`) is shared with view windows so a table and
 * a view fronted moments apart still compare correctly against each other.
 */
function stampFrontOrder(tableId: string, ctx: AppContext): Promise<void> {
  // Serialized against saveGeometry — see geometry-writes.ts.
  return queueGeometryWrite(`table:${tableId}`, () => writeFrontOrder(tableId, ctx));
}

async function writeFrontOrder(tableId: string, ctx: AppContext): Promise<void> {
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
