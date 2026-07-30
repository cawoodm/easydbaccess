/**
 * Core window manager for View windows.
 *
 * View windows are managed by the CORE, exactly like table windows are managed
 * by `jspanel-manager.ts` — window behaviour (drag/resize/maximize), geometry,
 * persistence, and boot-time restore are core responsibilities, NOT the `views`
 * plugin's. The plugin only owns data + intent: it seeds templates and the
 * dialog flips a `ViewInstance.open` flag. This manager reacts to that flag,
 * opening/closing the actual jsPanel windows and persisting their geometry.
 *
 * Mirrors the table window manager: a workspace-scoped subscription reconciles
 * live state (which instances are `open`) against the set of open panels, so a
 * window opens when its instance is flagged open and closes when the flag drops
 * or the instance is deleted. On boot, every instance already flagged `open`
 * gets its window re-created (jsPanel itself has no cross-reload memory).
 *
 * Z-ordering also mirrors the table manager: `onfronted` stamps a monotonic
 * front-rank into `windowGeometry.z` (shared counter with tables — see
 * `front-order.ts`), and the boot/reactive-open loops sort by it. That only
 * orders views AMONG THEMSELVES, though — restoring the relative order
 * BETWEEN a table and a view is a deliberately separate, cross-manager
 * concern; see `restack.ts` (this manager stays independent of
 * `jspanel-manager.ts` except for the shared `currentPanZoom` handle).
 */

// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';
import type { Table, ViewInstance, WindowGeometry } from '@easydb/shared';
import { getContext, type AppContext } from '../app-context.js';
import { currentPanZoom } from './jspanel-manager.js';
import { createMaximizeFill } from './maximize-fill.js';
import { forgetMaximized, primeMaximized, trackMaximized } from './maximized-memory.js';
import { queueGeometryWrite } from './geometry-writes.js';
import { countSuffix, VISIBLE_COUNT_EVENT, type VisibleCountDetail } from './panel-title.js';
import { VIEW_ICON } from './table-kind.js';
import { byAscendingZ } from './geometry.js';
import { nextFrontZ } from './front-order.js';
import { registerPanel, unregisterPanel } from './panel-registry.js';
// Side-effect import registers the <view-window> custom element; the type-only
// import would otherwise be elided, leaving <view-window> an unupgraded
// (inline, zero-size) element.
import '../views/view-window.js';
import type { ViewWindow } from '../views/view-window.js';
// Core header search box — the same component the table windows use.
import '../chrome/panel-search.js';

/** jsPanel instance — typed loose since the lib ships no .d.ts. */
type Panel = {
  id: string;
  close(): void;
  // jsPanel: front(callback, execOnFrontedCallbacks = true). Passing `false`
  // fronts WITHOUT firing `onfronted` (so without stamping a new front rank).
  front?: (callback?: undefined, execOnFrontedCallbacks?: boolean) => void;
  minimize?: () => void;
  maximize?: () => void;
  setHeaderTitle?: (title: string) => void;
  status: 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
};

/** Per-open-view window state: the panel, its element, and title inputs. */
interface ViewEntry {
  panel: Panel;
  /**
   * The mounted <view-window>, or null while the panel is minimized — a
   * minimized view is detached so it holds no rows and no subscription.
   */
  el: ViewWindow | null;
  /** The instance name (kept fresh on rename) — the title's text part. */
  name: string;
  /** Last reported visible/total counts (-1 until the view emits one). */
  count: number;
  total: number;
}

const panels = new Map<string, ViewEntry>();

/**
 * Brings an already-open view window to the front (restoring it if minimized).
 * The command palette's "Go to view" command patches `open: true` first (which
 * opens a closed view via the reactive reconcile below); this fronts one that
 * is already open. Returns false if no window is currently open for that id.
 */
/** The view-window half of `persistTablePanelGeometry` — see its comment. */
export async function persistViewWindowGeometry(): Promise<void> {
  await Promise.all([...panels.keys()].map((id) => saveGeometry(id)));
}

export function focusViewWindow(instanceId: string): boolean {
  const entry = panels.get(instanceId);
  if (!entry) return false;
  const panel = entry.panel as Panel & { normalize?: () => void };
  if (panel.status === 'minimized') panel.normalize?.();
  panel.front?.();
  return true;
}
let initialized = false;

/** Render a view panel's titlebar: "<name> (<count>)" / "(<visible>/<total>)". */
function renderViewTitle(entry: ViewEntry): void {
  entry.panel.setHeaderTitle?.(entry.name + countSuffix(entry.count, entry.total));
}

/** Element view windows mount into — the pan/zoom-transformed canvas viewport. */
function viewContainer(): HTMLElement {
  return (
    document.getElementById('easydb-panels-viewport') ??
    document.getElementById('easydb-panels') ??
    document.body
  );
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function panelDomId(instanceId: string): string {
  return `view-panel-${cssSafe(instanceId)}`;
}

export async function initViewWindowManager(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const ctx = await getContext();

  const openInWs = (all: ViewInstance[]): ViewInstance[] =>
    all.filter((i) => i.workspaceId === ctx.workspaceId && i.open);

  // Initial restore: reopen every instance already flagged open, in ascending
  // saved-z order (mirrors the table window manager) so jsPanel's internal
  // zi.next() counter reproduces the last layering AMONG views. Restoring the
  // relative order BETWEEN tables and views is a separate, cross-kind pass —
  // see `restack.ts`.
  const initial = openInWs(await ctx.store.viewInstances.find()).sort(byAscendingZ);
  for (const inst of initial) openPanel(inst, ctx);

  // Reactive reconcile: open windows for newly-open instances, close windows
  // whose instance is no longer open (flag dropped) or was deleted.
  ctx.store.viewInstances.subscribe((all) => {
    const want = new Map(openInWs(all).map((i) => [i.id, i]));
    for (const id of [...panels.keys()]) if (!want.has(id)) closePanel(id);
    const toOpen = [...want.values()].filter((i) => !panels.has(i.id)).sort(byAscendingZ);
    for (const inst of toOpen) openPanel(inst, ctx);
  });

  // Reconnect-by-name: a view binds to its table by `tableId`, but deleting a
  // table and recreating it under the same name mints a fresh id, orphaning the
  // view (its `tableId` now dangles). Whenever the set of tables changes, rebind
  // any dangling view to a same-named table in the workspace. The view-window's
  // own instance subscription then reloads and re-binds its rows subscription.
  ctx.store.tables.subscribe((tables) => void reconnectDanglingViews(ctx, tables));

  // The open view window (its <view-window>, or its <data-table> in
  // template-off mode) emits its visible/total row count keyed by the view
  // instance id — mirror it into the titlebar so it reacts to search + filters.
  document.addEventListener(VISIBLE_COUNT_EVENT, (e) => {
    const d = (e as CustomEvent<VisibleCountDetail>).detail;
    const entry = panels.get(d.key);
    if (!entry) return;
    // A detached (minimized) view has no meaningful count, and tearing one down
    // emits a final event — which would otherwise restore the "(n)" suffix that
    // unmountContent just cleared.
    if (!entry.el) return;
    entry.count = d.count;
    entry.total = d.total;
    renderViewTitle(entry);
  });

  // Apply an instance edit (rename / re-mapping) to an already-open window
  // without tearing it down.
  document.addEventListener('easydb:reload-view', (e) => {
    const id = (e as CustomEvent<{ instanceId: string }>).detail?.instanceId;
    if (!id) return;
    const entry = panels.get(id);
    if (!entry) return;
    void (async () => {
      const inst = await ctx.store.viewInstances.findOne(id);
      if (inst) {
        entry.name = inst.name;
        renderViewTitle(entry);
      }
      // Nothing to reload while minimized — expanding mounts a fresh view that
      // reads the current instance anyway.
      void entry.el?.reload();
    })();
  });

  // A template edit can affect several open views at once — reload them all.
  document.addEventListener('easydb:reload-views', () => {
    for (const { el } of panels.values()) void el?.reload();
  });
}

/**
 * Rebind views whose `tableId` no longer resolves to a table, matching on the
 * snapshotted `tableName` within the same workspace. A no-op unless a dangling
 * view has a same-named table to reconnect to, so it's safe to run on every
 * table write.
 */
async function reconnectDanglingViews(ctx: AppContext, tables: Table[]): Promise<void> {
  const wsTables = tables.filter((t) => t.workspaceId === ctx.workspaceId);
  const byId = new Set(wsTables.map((t) => t.id));
  // First same-named table wins if duplicates exist.
  const byName = new Map<string, Table>();
  for (const t of wsTables) if (!byName.has(t.name)) byName.set(t.name, t);

  const insts = await ctx.store.viewInstances.find();
  for (const inst of insts) {
    if (inst.workspaceId !== ctx.workspaceId) continue;
    if (byId.has(inst.tableId)) continue; // still bound to a live table
    if (!inst.tableName) continue; // no name snapshot to match on
    const match = byName.get(inst.tableName);
    if (!match) continue; // no same-named table to reconnect to
    await ctx.store.viewInstances.patch(inst.id, {
      tableId: match.id,
      updatedAt: Date.now(),
    });
  }
}

function openPanel(inst: ViewInstance, ctx: AppContext): void {
  if (panels.has(inst.id)) return;
  const panelId = panelDomId(inst.id);

  const g = inst.windowGeometry;
  const startMinimized = g?.minimized === true;

  // A live <view-window> subscribes to the underlying table's rows the moment it
  // connects — which, for a remote/live table, FETCHES. So mount it lazily: a
  // view that opens minimized gets a bare placeholder and loads nothing until
  // it's expanded. Minimizing later detaches it again, dropping its rows and
  // unsubscribing (see the element's disconnectedCallback).
  const makeView = (): ViewWindow => {
    const el = document.createElement('view-window') as ViewWindow;
    el.viewInstanceId = inst.id;
    el.style.height = '100%';
    return el;
  };
  const content: HTMLElement = startMinimized ? document.createElement('div') : makeView();

  // Declared before jsPanel.create because the create options close over them.
  // `entry` can only be filled in after create returns (it holds the panel), so
  // the mount helpers tolerate its absence — during create there is nothing
  // mounted to change anyway.
  let entry: ViewEntry | undefined;

  const unmountContent = (): void => {
    if (!entry) return;
    entry.el?.remove();
    entry.el = null;
    // A detached view emits no row counts, so drop the stale "(n/m)" suffix.
    entry.count = -1;
    entry.total = -1;
    renderViewTitle(entry);
  };

  const mountContent = (): void => {
    if (!entry || entry.el) return;
    const host = document
      .getElementById(panelId)
      ?.querySelector('.jsPanel-content') as HTMLElement | null;
    if (!host) return;
    host.replaceChildren(); // drop the minimized placeholder / any stale node
    const el = makeView();
    host.appendChild(el);
    entry.el = el;
  };
  const sizeOpt = g ? { panelSize: `${g.w} ${g.h}` } : { contentSize: '480 520' };
  const position = g
    ? { my: 'left-top', at: 'left-top', offsetX: g.x, offsetY: g.y }
    : { my: 'center-top', at: 'center-top', offsetY: 60 };

  // Keep a maximized view filling the visible area through canvas pan/zoom —
  // the same counter-transform the table windows use (shared handle).
  const maxFill = createMaximizeFill(panelId, currentPanZoom);

  const panel = jsPanel.create({
    id: panelId,
    container: viewContainer(),
    headerTitle: inst.name,
    // Eye icon at the far left of the titlebar — a view's kind never changes
    // at runtime (unlike a table's), so this is drawn once here (table-kind.ts).
    headerLogo: VIEW_ICON,
    // A distinct cyan chrome so view windows read as different from tables.
    theme: '#0891b2',
    content,
    ...sizeOpt,
    position,
    minimizeTo: '#easydb-minimized-dock',
    dragit: { containment: false, stop: () => void saveGeometry(inst.id) },
    resizeit: { containment: false, stop: () => void saveGeometry(inst.id) },
    // Fires when the panel is focused/brought-to-front by any means. Mirrors
    // the table window manager's `onfronted` exactly (see its comment): DOM
    // zIndex isn't a stable identity (jsPanel's resetZi() renormalizes it on
    // every front()), so we stamp a monotonic wall-clock rank instead —
    // shared with tables via `nextFrontZ()` so the two kinds compare
    // correctly in the merged cross-kind restack (`restack.ts`).
    onfronted: () => void stampViewFrontOrder(inst.id, ctx),
    onstatuschange: (p: Panel) => {
      if (p.status === 'maximized') maxFill.enter();
      else maxFill.exit();
      // Detach the view while minimized; remount it fresh (re-reading the store)
      // when it comes back. Mirrors the table windows.
      if (p.status === 'minimized') unmountContent();
      else if (p.status === 'normalized' || p.status === 'maximized') mountContent();
      trackMaximized(`view:${inst.id}`, p);
      // Persist the new status (minimized / maximized / normalized) so it
      // survives a reload, exactly like table windows.
      void saveGeometry(inst.id);
    },
    onclosed: () => {
      panels.delete(inst.id);
      unregisterPanel(inst.id);
      maxFill.exit();
      forgetMaximized(`view:${inst.id}`);
      // The user closed the window → drop the persisted open flag so it isn't
      // reopened on the next boot. (Closing because the flag already dropped is
      // a harmless redundant write; the reconcile subscription is idempotent.)
      void ctx.store.viewInstances
        .patch(inst.id, { open: false, updatedAt: Date.now() })
        .catch(() => {
          /* instance may have been deleted — ignore */
        });
    },
  }) as Panel;

  entry = {
    panel,
    el: startMinimized ? null : (content as ViewWindow),
    name: inst.name,
    count: -1,
    total: -1,
  };
  panels.set(inst.id, entry);
  // Registered so the global restack (`restack.ts`) can front this panel
  // without importing this module directly — see `panel-registry.ts`. The
  // `false` suppresses jsPanel's `onfronted`, so a restack does NOT re-stamp
  // the front rank it is itself ordering by.
  registerPanel(inst.id, () => panel.front?.(undefined, false));

  const panelEl = document.getElementById(panelId);

  // Inject the core per-window search box into the titlebar controlbar (next to
  // min/max/close), keyed by the view INSTANCE id so a view's search filters the
  // view's rows independently of the underlying table window's search.
  const search = document.createElement('panel-search');
  (search as HTMLElement & { tableId: string }).tableId = inst.id;
  panelEl?.querySelector('.jsPanel-controlbar')?.prepend(search);

  // Make the titlebar focusable so tapping it blurs (collapses) an open search
  // box — matches the table windows.
  const titlebar = panelEl?.querySelector('.jsPanel-titlebar') as HTMLElement | null;
  if (titlebar) {
    titlebar.tabIndex = -1;
    titlebar.style.outline = 'none';
    titlebar.addEventListener('pointerdown', () => titlebar.focus());
  }

  // Restore a persisted minimized/maximized state. Defer to the next tick so
  // jsPanel finishes its own init (centering, sizing) before we drive a state
  // change — mirrors the table window manager.
  // Minimized wins: a window stored as minimized AND maximized went down from
  // maximized last session, so it restores maximized (see maximized-memory.ts).
  if (g?.minimized) {
    if (g.maximized) primeMaximized(`view:${inst.id}`);
    queueMicrotask(() => panel.minimize?.());
  } else if (g?.maximized) {
    queueMicrotask(() => panel.maximize?.());
  }
}

function closePanel(instanceId: string): void {
  const entry = panels.get(instanceId);
  if (!entry) return;
  panels.delete(instanceId);
  unregisterPanel(instanceId);
  try {
    if (entry.panel.status !== 'closed') entry.panel.close();
  } catch {
    /* already gone */
  }
}

/**
 * Save a "front rank" into windowGeometry.z, exactly like the table window
 * manager's `stampFrontOrder` (see its comment in `jspanel-manager.ts`) —
 * `nextFrontZ()` is the SAME shared counter, so a table and a view fronted
 * moments apart still compare correctly in the merged restack.
 */
function stampViewFrontOrder(instanceId: string, ctx: AppContext): Promise<void> {
  // Serialized against saveGeometry — see geometry-writes.ts.
  return queueGeometryWrite(`view:${instanceId}`, () => writeViewFrontOrder(instanceId, ctx));
}

async function writeViewFrontOrder(instanceId: string, ctx: AppContext): Promise<void> {
  try {
    const inst = await ctx.store.viewInstances.findOne(instanceId);
    if (!inst) return;
    const geom = inst.windowGeometry ?? {
      x: 0,
      y: 0,
      w: 480,
      h: 520,
      z: 0,
      minimized: false,
      maximized: false,
    };
    await ctx.store.viewInstances.patch(instanceId, {
      windowGeometry: { ...geom, z: nextFrontZ() },
      updatedAt: Date.now(),
    });
  } catch {
    /* instance may have just been deleted — ignore */
  }
}

function saveGeometry(instanceId: string): Promise<void> {
  // Serialized against stampViewFrontOrder: both patch the whole geometry.
  return queueGeometryWrite(`view:${instanceId}`, () => writeViewGeometry(instanceId));
}

async function writeViewGeometry(instanceId: string): Promise<void> {
  const el = document.getElementById(panelDomId(instanceId));
  const entry = panels.get(instanceId);
  if (!el || !entry) return;
  const status = entry.panel.status;
  const minimized = status === 'minimized';
  try {
    const ctx = await getContext();
    const prev = (await ctx.store.viewInstances.findOne(instanceId))?.windowGeometry;
    // A minimized window keeps the maximized flag it went down with, so a
    // restore after a reload maximizes again (see maximized-memory.ts).
    const maximized = minimized ? (prev?.maximized ?? false) : status === 'maximized';
    // Only the normalized rect is meaningful; while minimized jsPanel parks the
    // panel at left:-9999 and while maximized it fills the container, so in
    // those states keep the last-stored normal rect and only flip the flag.
    let x = el.offsetLeft;
    let y = el.offsetTop;
    let w = el.offsetWidth;
    let h = el.offsetHeight;
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
      // Preserve the front-order rank written by stampViewFrontOrder — a
      // geometry save (drag/resize/status-change) must not clobber it back to
      // 0, or the window's stacking position would be forgotten on reload.
      z: prev?.z ?? 0,
      minimized,
      maximized,
    };
    await ctx.store.viewInstances.patch(instanceId, {
      windowGeometry: geom,
      updatedAt: Date.now(),
    });
  } catch {
    /* instance may have been deleted — ignore */
  }
}
