/**
 * Core window manager for View windows, running on the in-repo panel shell
 * (`panel-shell/panel-shell.ts`) — the same shell table windows run on
 * (`table-window-manager.ts`).
 *
 * View windows are managed by the CORE, exactly like table windows are managed
 * by `table-window-manager.ts` — window behaviour (drag/resize/maximize), geometry,
 * persistence, and boot-time restore are core responsibilities, NOT the `views`
 * plugin's. The plugin only owns data + intent: it seeds templates and the
 * dialog flips a `ViewInstance.open` flag. This manager reacts to that flag,
 * opening/closing the actual panel-shell windows and persisting their geometry.
 *
 * Mirrors the table window manager: a workspace-scoped subscription reconciles
 * live state (which instances are `open`) against the set of open panels, so a
 * window opens when its instance is flagged open and closes when the flag drops
 * or the instance is deleted. On boot, every instance already flagged `open`
 * gets its window re-created (the shell itself has no cross-reload memory).
 *
 * Z-ordering also mirrors the table manager: `onfronted` stamps a monotonic
 * front-rank into `windowGeometry.z` (shared counter with tables — see
 * `front-order.ts`), and the boot/reactive-open loops sort by it. That only
 * orders views AMONG THEMSELVES, though — restoring the relative order
 * BETWEEN a table and a view is a deliberately separate, cross-manager
 * concern; see `restack.ts` (this manager stays independent of
 * `table-window-manager.ts` except for the shared `shellViewport()` adapter, which
 * both kinds use so a maximized panel of either kind fills the same canvas).
 */

import type { Table, ViewInstance, ViewTemplate, WindowGeometry } from '@easydb/shared';
import { getContext, type AppContext } from '../app-context.js';
import { shellViewport } from './shell-viewport.js';
import { queueGeometryWrite } from './geometry-writes.js';
import { countSuffix, VISIBLE_COUNT_EVENT, type VisibleCountDetail } from './panel-title.js';
import { VIEW_ICON, VIZ_ICON } from './table-kind.js';
import { byAscendingZ } from './geometry.js';
import { nextFrontZ } from './front-order.js';
import { registerPanel, unregisterPanel } from './panel-registry.js';
import { createPanel, type PanelShellEl } from './panel-shell/panel-shell.js';
import { createPanelStack, type PanelStack } from './panel-stack.js';
import { getPanelStack, hostKey, onPanelStacksChanged, registerPanelStack, unregisterPanelStack } from './panel-stacks.js';
import '../viz/viz-pane.js';
import { PANE_HEADER_H } from '../viz/viz-pane.js';
import '../viz/viz-footer.js';
import { revealPanel } from './reveal.js';
// Side-effect import registers the <view-window> custom element; the type-only
// import would otherwise be elided, leaving <view-window> an unupgraded
// (inline, zero-size) element.
import '../views/view-window.js';
import type { ViewWindow } from '../views/view-window.js';
// Side-effect import registers <viz-panel> (and the drawing tags it defines).
import '../viz/viz-panel.js';
import type { VizPanel } from '../viz/viz-panel.js';
// Core header search box — the same component the table windows use.
import '../chrome/panel-search.js';

/** Opening size of a view window, and the fallback when nothing is stored. */
const DEFAULT_W = 480;
const DEFAULT_H = 520;

/**
 * Either kind of mounted content. Both expose `reload()`, which is all this
 * manager ever calls on them — so the two kinds need no branching past mount.
 */
type ViewContent = ViewWindow | VizPanel;

/** Per-open-view window state: the panel, its element, and title inputs. */
interface ViewEntry {
  panel: PanelShellEl;
  /**
   * The mounted <view-window> or <viz-panel>, or null while the panel is
   * minimized — a minimized view is detached so it holds no rows and no
   * subscription. A visualization holds a chart instance too, so this matters
   * more for one than it ever did for the other.
   */
  el: ViewContent | null;
  /** The instance name (kept fresh on rename) — the title's text part. */
  name: string;
  /** Last reported visible/total counts (-1 until the view emits one). */
  count: number;
  total: number;
}

const panels = new Map<string, ViewEntry>();

/**
 * Instances whose window this manager is closing ITSELF, so the shell's
 * `onclosed` must not read it as the user shutting the view.
 *
 * Mirrors `externallyClosed` in `table-window-manager.ts`, and for a sharper
 * reason: `onclosed` writes `open: false`, which is right when the user clicks X
 * and WRONG when the window is closing because the instance just became DOCKED.
 * `open` is the flag a pane is shown by too, so writing it there removed the pane
 * the reconcile had just mounted — moving a chart to above/below the grid made it
 * vanish altogether.
 */
const selfClosed = new Set<string>();

/**
 * Template ids whose `kind` is `'viz'`, kept live.
 *
 * `openPanel` is synchronous (both reconcile loops call it in a tight pass), but
 * deciding which element to mount needs the TEMPLATE, which lives in another
 * collection. Rather than make the open path async — and race the reconcile — this
 * mirrors the small amount of template state the decision needs. A template
 * switched between kinds reopens its windows, which is the same treatment a
 * template edit already gets via `easydb:reload-views`.
 */
const vizTemplates = new Set<string>();

function isVizTemplate(templateId: string): boolean {
  return vizTemplates.has(templateId);
}

/** True when this instance draws rather than lays out HTML. */
function instanceIsViz(inst: ViewInstance): boolean {
  return isVizTemplate(inst.templateId);
}

/** The view-window half of `persistTablePanelGeometry` — see its comment. */
export async function persistViewWindowGeometry(): Promise<void> {
  await Promise.all([...panels.keys()].map((id) => saveGeometry(id)));
}

/**
 * Show an ALREADY-OPEN view window: restore it if minimized, put it where the
 * user is looking (or fill the screen on a phone), and front it. Returns false
 * when no window is open for that id — callers that also need to OPEN one want
 * `revealViewWindow` instead.
 */
export function focusViewWindow(instanceId: string): boolean {
  const entry = panels.get(instanceId);
  if (!entry) return false;
  // One reveal behaviour for every window, table or view — see `reveal.ts`.
  revealPanel(entry.panel);
  return true;
}

/**
 * Instances asked for before their window existed. `openPanel` drains this as
 * it creates each panel, so "open this view" works whether the view was already
 * open, minimized, or closed — the closed case has to wait for the store
 * subscription to reconcile, and polling for the panel would race it.
 */
const pendingReveal = new Set<string>();

/**
 * Show a view: front it, restore it if minimized, put it where the user is
 * looking (or fill the screen on mobile) — opening its window first if it is
 * not open yet.
 *
 * This is what the Views dialog's "Open" button and the command palette both
 * want. Flipping `ViewInstance.open` alone is not enough: for a view that is
 * ALREADY open the flag does not change, so the reconcile has nothing to do and
 * the click appeared to do nothing.
 */
export async function revealViewWindow(instanceId: string): Promise<void> {
  if (focusViewWindow(instanceId)) return;
  pendingReveal.add(instanceId);
  const ctx = await getContext();
  const inst = await ctx.store.viewInstances.findOne(instanceId);
  if (!inst) {
    pendingReveal.delete(instanceId);
    return;
  }
  // Already flagged open but with no window (mid-boot, or another device's
  // flag): the reconcile will not fire for an unchanged flag, so open it here.
  if (inst.open) {
    openPanel(inst, ctx);
    drainReveal(instanceId);
    return;
  }
  await ctx.store.viewInstances.patch(instanceId, { open: true, updatedAt: Date.now() });
}

/** Focus a freshly-created panel if something asked for it before it existed. */
function drainReveal(instanceId: string): void {
  if (!pendingReveal.delete(instanceId)) return;
  focusViewWindow(instanceId);
}

let initialized = false;

/** Render a view panel's titlebar: "<name> (<count>)" / "(<visible>/<total>)". */
function renderViewTitle(entry: ViewEntry): void {
  entry.panel.setHeaderTitle(entry.name + countSuffix(entry.count, entry.total));
}

/** Element view windows mount into — the pan/zoom-transformed canvas viewport. */
function viewContainer(): HTMLElement {
  return document.getElementById('easydb-panels-viewport') ?? document.getElementById('easydb-panels') ?? document.body;
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
    // A DOCKED instance is not a window: its pane is mounted into a host panel by
    // `panel-stack`, driven by the same `open` flag. One flag, two presentations.
    all.filter((i) => i.workspaceId === ctx.workspaceId && i.open && !i.dock);

  // Prime the viz-template set before the first open, so a boot restore mounts
  // the right element rather than a <view-window> that then has to be swapped.
  const primeVizTemplates = (all: ViewTemplate[]): void => {
    vizTemplates.clear();
    for (const t of all) if (t.kind === 'viz') vizTemplates.add(t.id);
  };
  primeVizTemplates(await ctx.store.viewTemplates.find());
  ctx.store.viewTemplates.subscribe(primeVizTemplates);

  // Initial restore: reopen every instance already flagged open, in ascending
  // saved-z order (mirrors the table window manager) so the shell's session
  // z-counter reproduces the last layering AMONG views. Restoring the
  // relative order BETWEEN tables and views is a separate, cross-kind pass —
  // see `restack.ts`.
  const initial = openInWs(await ctx.store.viewInstances.find()).sort(byAscendingZ);
  for (const inst of initial) openPanel(inst, ctx);

  // Reactive reconcile: open windows for newly-open instances, close windows
  // whose instance is no longer open (flag dropped) or was deleted.
  //
  // ONE reconciler for both presentations. A docked instance is filtered out of
  // `openInWs` and handled by `reconcileDockedPanes` in the same pass, so
  // toggling `dock` moves a visualization between a window and a pane with no
  // second source of truth about what should be shown.
  let latest: ViewInstance[] = [];
  ctx.store.viewInstances.subscribe((all) => {
    latest = all;
    const want = new Map(openInWs(all).map((i) => [i.id, i]));
    for (const id of [...panels.keys()]) if (!want.has(id)) closePanel(id);
    const toOpen = [...want.values()].filter((i) => !panels.has(i.id)).sort(byAscendingZ);
    for (const inst of toOpen) openPanel(inst, ctx);
    reconcileDockedPanes(all, ctx);
  });

  // A host panel appearing is not a store change, but it is exactly when a pane
  // waiting for it can finally mount — a table window finishing its boot restore,
  // or being expanded out of the dock. Without this, a pane whose host opened
  // second would never appear.
  onPanelStacksChanged(() => reconcileDockedPanes(latest, ctx));

  // A template switching kind (html <-> viz) has to re-mount: the element is
  // chosen at open time, so an already-open window is showing the wrong one.
  ctx.store.viewTemplates.subscribe(() => {
    for (const [id, entry] of [...panels.entries()]) {
      const inst = latest.find((i) => i.id === id);
      if (!inst) continue;
      const shouldBeViz = instanceIsViz(inst);
      const isViz = entry.el?.tagName.toLowerCase() === 'viz-panel';
      if (entry.el && shouldBeViz !== isViz) {
        // Cheapest correct fix: close and let the reconcile reopen it with the
        // right element. Geometry is persisted, so nothing visible is lost.
        closePanel(id);
        openPanel(inst, ctx);
      }
    }
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

  // The same edit has to reach a DOCKED pane, which has no panel entry at all.
  document.addEventListener('easydb:reload-view', (e) => {
    const id = (e as CustomEvent<{ instanceId: string }>).detail?.instanceId;
    if (id) reloadDockedPanes(id);
  });

  // A template edit can affect several open views at once — reload them all.
  document.addEventListener('easydb:reload-views', () => {
    for (const { el } of panels.values()) void el?.reload();
    reloadDockedPanes();
  });
}

/** Docked pane ids currently mounted, and which host they went into. */
const dockedPanes = new Map<string, string>();

/**
 * Push an instance/template edit into mounted panes. Given an id, only that one.
 *
 * A pane is not in `panels` — it has no panel of its own — so the reload paths
 * that walk that map miss it entirely. Found by DOM query rather than by keeping
 * a second element map: the stack owns the element's lifetime, and a stale
 * reference to a pane its host already unmounted is exactly the bug that map
 * would introduce.
 */
function reloadDockedPanes(instanceId?: string): void {
  for (const id of dockedPanes.keys()) {
    if (instanceId && id !== instanceId) continue;
    const el = document.querySelector(`viz-pane[data-instance="${CSS.escape(id)}"]`) as (HTMLElement & { reload?: () => Promise<void> }) | null;
    void el?.reload?.();
  }
}

/**
 * Mount / unmount docked visualization panes against their host panels' stacks.
 *
 * The counterpart of the window reconcile above, and deliberately the same shape:
 * work out what SHOULD be mounted, drop what should not be, add what is missing.
 * A pane whose host is closed or minimized has nowhere to go and simply is not
 * mounted — correct rather than deferred, because a minimized host holds no grid
 * to publish rows either.
 */
function reconcileDockedPanes(all: ViewInstance[], ctx: AppContext): void {
  const want = new Map<string, ViewInstance>();
  for (const inst of all) {
    if (inst.workspaceId !== ctx.workspaceId) continue;
    if (!inst.open || !inst.dock) continue;
    if (!instanceIsViz(inst)) continue; // only visualizations dock, for now
    want.set(inst.id, inst);
  }

  // Remove panes that should no longer be there, or whose host changed.
  for (const [id, key] of [...dockedPanes.entries()]) {
    const inst = want.get(id);
    const stillThere = inst && inst.dock && hostKey(inst.dock.host) === key;
    if (stillThere) continue;
    getPanelStack(key)?.removePane(id);
    dockedPanes.delete(id);
  }

  for (const inst of want.values()) {
    const dock = inst.dock as NonNullable<ViewInstance['dock']>;
    const key = hostKey(dock.host);
    const stack = getPanelStack(key);
    if (!stack) continue; // host not mounted — try again when it registers
    if (stack.hasPane(inst.id)) continue;

    const pane = document.createElement('viz-pane') as HTMLElement & { viewInstanceId: string; label: string };
    pane.viewInstanceId = inst.id;
    pane.label = inst.name;
    // Queryable identity, so a reload can find it without a second element map.
    pane.dataset['instance'] = inst.id;
    // Collapsing hides the pane's body; the stack has to shrink the pane with
    // it, or the room the body gave up stays an empty box instead of going back
    // to the grid. Local state, exactly like the pane's own flag — see the note
    // on `VizPane.toggleCollapse`.
    pane.addEventListener('viz-pane-collapse', (ev) => {
      const collapsed = (ev as CustomEvent<{ collapsed: boolean }>).detail.collapsed;
      stack.setPaneCollapsed(inst.id, collapsed ? PANE_HEADER_H : null);
    });

    stack.addPane({
      id: inst.id,
      el: pane,
      edge: dock.edge,
      size: dock.size,
      order: dock.order,
      // Persisted through the same serialized queue every other geometry write
      // uses, so a splitter release cannot interleave with a window drag save.
      onResized: (size) => void persistDockSize(inst.id, size),
    });
    dockedPanes.set(inst.id, key);
  }
}

/** Write a pane's settled height back onto its instance. */
function persistDockSize(instanceId: string, size: number): Promise<void> {
  return queueGeometryWrite(`view:${instanceId}`, async () => {
    try {
      const ctx = await getContext();
      const inst = await ctx.store.viewInstances.findOne(instanceId);
      if (!inst?.dock) return;
      if (inst.dock.size === size) return;
      await ctx.store.viewInstances.patch(instanceId, {
        dock: { ...inst.dock, size },
        updatedAt: Date.now(),
      });
    } catch {
      /* instance may have been deleted mid-drag — ignore */
    }
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
  const isViz = instanceIsViz(inst);
  const makeView = (): ViewContent => {
    const el = document.createElement(isViz ? 'viz-panel' : 'view-window') as ViewContent;
    el.viewInstanceId = inst.id;
    el.style.height = '100%';
    return el;
  };
  // A view window gets a stack too, so a chart can be docked above or below a
  // view exactly as it can above a grid. Same guarantee: empty, it is a no-op.
  let stack: PanelStack | null = null;
  let primaryEl: ViewContent | null = null;
  const stackKey = `view:${inst.id}`;
  const buildStack = (el: ViewContent): HTMLElement => {
    primaryEl = el;
    stack = createPanelStack();
    stack.setPrimary(el);
    registerPanelStack(stackKey, stack);
    return stack.root;
  };
  const content: HTMLElement = startMinimized ? document.createElement('div') : buildStack(makeView());

  // Declared before createPanel because the create options close over them.
  // `entry` can only be filled in after create returns (it holds the panel), so
  // the mount helpers tolerate its absence — during create there is nothing
  // mounted to change anyway.
  // eslint-disable-next-line prefer-const -- closures above must capture the binding before it is assigned
  let entry: ViewEntry | undefined;

  const unmountContent = (): void => {
    if (!entry) return;
    unregisterPanelStack(stackKey);
    stack?.destroy();
    stack = null;
    entry.el?.remove();
    entry.el = null;
    // A detached view emits no row counts, so drop the stale "(n/m)" suffix.
    entry.count = -1;
    entry.total = -1;
    renderViewTitle(entry);
  };

  const mountContent = (): void => {
    if (!entry || entry.el) return;
    const host = document.getElementById(panelId)?.querySelector('.jsPanel-content') as HTMLElement | null;
    if (!host) return;
    host.replaceChildren(); // drop the minimized placeholder / any stale node
    const el = makeView();
    host.appendChild(buildStack(el));
    entry.el = el;
  };

  // A visualization window gets a footer with its own Edit buttons: what it shows
  // IS a configuration, and the only route back to it was the table's Views
  // button, which is not discoverable from the chart. An HTML view has nothing to
  // configure per-window, so it keeps no footer.
  let vizFooter: HTMLElement | undefined;
  if (isViz) {
    const f = document.createElement('viz-footer') as HTMLElement & { viewInstanceId: string };
    f.viewInstanceId = inst.id;
    vizFooter = f;
  }

  const panel = createPanel({
    id: panelId,
    container: viewContainer(),
    title: inst.name,
    logo: isViz ? VIZ_ICON : VIEW_ICON,
    // Distinct chrome so a window reads as what it is at a glance: cyan for an
    // HTML view, violet for a visualization.
    color: isViz ? '#7c3aed' : '#0891b2',
    ...(vizFooter ? { footerToolbar: vizFooter } : {}),
    content,
    ...(g ? { panelSize: { w: g.w, h: g.h }, position: { x: g.x, y: g.y } } : { contentSize: { w: DEFAULT_W, h: DEFAULT_H }, position: { centerTopOffset: 60 } }),
    minimizeTo: '#easydb-minimized-dock',
    viewport: shellViewport(),
    boot: {
      minimized: g?.minimized === true,
      maximized: g?.maximized === true,
      smallified: g?.smallified === true,
    },
    onmoved: () => void saveGeometry(inst.id),
    onresized: () => void saveGeometry(inst.id),
    // Stamp a monotonic front rank; DOM z stays session-local in the shell but
    // the persisted rank must survive reloads and merge with tables
    // (front-order.ts / restack.ts).
    onfronted: () => void stampViewFrontOrder(inst.id, ctx),
    onstatuschange: (p) => {
      // Detach the view while minimized; remount it fresh (re-reading the store)
      // when it comes back. Mirrors the table windows.
      if (p.status === 'minimized') unmountContent();
      else if (p.status === 'normalized' || p.status === 'maximized') mountContent();
      // Persist the new status (minimized / maximized / normalized) so it
      // survives a reload, exactly like table windows.
      void saveGeometry(inst.id);
    },
    onclosed: () => {
      unregisterPanelStack(stackKey);
      stack?.destroy();
      stack = null;
      panels.delete(inst.id);
      unregisterPanel(inst.id);
      // This manager closed the window itself (the flag dropped, or the instance
      // became docked) — the store already says what should happen, so writing
      // `open: false` here would either be redundant or actively wrong.
      if (selfClosed.delete(inst.id)) return;
      // The USER closed the window → drop the persisted open flag so it isn't
      // reopened on the next boot.
      void ctx.store.viewInstances.patch(inst.id, { open: false, updatedAt: Date.now() }).catch(() => {
        /* instance may have been deleted — ignore */
      });
    },
  });

  entry = {
    panel,
    // `content` is the STACK root now, not the element — the element itself is
    // what the entry tracks, since that is what `reload()` is called on.
    el: startMinimized ? null : primaryEl,
    name: inst.name,
    count: -1,
    total: -1,
  };
  panels.set(inst.id, entry);
  // Registered so the global restack (`restack.ts`) can front this panel
  // without importing this module directly — see `panel-registry.ts`. The
  // `false` suppresses the shell's `onfronted`, so a restack does NOT re-stamp
  // the front rank it is itself ordering by.
  registerPanel(inst.id, () => panel.front(undefined, false));

  const panelEl = document.getElementById(panelId);

  // Inject the core per-window search box into the titlebar controlbar, keyed
  // by the view INSTANCE id so a view's search filters the view's rows
  // independently of the underlying table window's search.
  //
  // APPENDED, so it sits at the very right of a view's header — past the
  // window buttons — rather than in front of them as it does on a table
  // window. Filtering is the control a view is used through, and the far
  // corner is the easiest target to hit.
  const search = document.createElement('panel-search');
  (search as HTMLElement & { tableId: string }).tableId = inst.id;
  panelEl?.querySelector('.jsPanel-controlbar')?.append(search);

  drainReveal(inst.id);
}

function closePanel(instanceId: string): void {
  const entry = panels.get(instanceId);
  if (!entry) return;
  panels.delete(instanceId);
  unregisterPanel(instanceId);
  try {
    // Marked only when a close is actually ISSUED, and immediately before it.
    // Marking unconditionally leaks the id when the panel is already closed
    // (`onclosed` never fires, so nothing clears it) — and a stale mark would
    // then swallow the `open: false` write on the NEXT genuine user close,
    // leaving a window the user shut reopening on the following boot.
    if (entry.panel.status !== 'closed') {
      selfClosed.add(instanceId);
      entry.panel.close();
    }
  } catch {
    selfClosed.delete(instanceId);
  }
}

/**
 * Save a "front rank" into windowGeometry.z, exactly like the table window
 * manager's `stampFrontOrder` (see its comment in `table-window-manager.ts`) —
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
    // Nothing stored yet: the panel's own rect, not a constant — the opening
    // constants are a CONTENT size, and this field holds a PANEL size.
    const geom = inst.windowGeometry ?? {
      ...(panels.get(instanceId)?.panel.persistRect() ?? {
        x: 0,
        y: 0,
        w: DEFAULT_W,
        h: DEFAULT_H,
      }),
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
  const entry = panels.get(instanceId);
  if (!entry) return;
  const { minimized, maximized, smallified } = entry.panel.persistFlags();
  // The shell decides which rect belongs in the store: a minimized panel is
  // display:none, a maximized one fills the container, and a collapsed one is
  // header-height, so none of their live boxes describe normal geometry.
  const rect = entry.panel.persistRect();
  try {
    const ctx = await getContext();
    const prev = (await ctx.store.viewInstances.findOne(instanceId))?.windowGeometry;
    const geom: WindowGeometry = {
      ...rect,
      // Preserve the front-order rank written by stampViewFrontOrder — a
      // geometry save (drag/resize/status-change) must not clobber it back to
      // 0, or the window's stacking position would be forgotten on reload.
      z: prev?.z ?? 0,
      minimized,
      maximized,
      smallified,
    };
    await ctx.store.viewInstances.patch(instanceId, {
      windowGeometry: geom,
      updatedAt: Date.now(),
    });
  } catch {
    /* instance may have been deleted — ignore */
  }
}
