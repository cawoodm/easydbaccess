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
 */

// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';
import 'jspanel4/es6module/jspanel.css';

import type { Table, WindowGeometry } from '@easydb/shared';
import { getContext, type AppContext } from '../app-context.js';
import '../table/data-table.js';
import '../chrome/panel-search.js';
import '../chrome/panel-footer.js';

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
 * that also briefly logs RxDB "not found" noise.
 */
const externallyClosed = new Set<string>();
let initialized = false;

export async function initWindowManager(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const ctx = await getContext();

  // Initial population. Open in ascending saved-z order so jsPanel's internal
  // zi.next() counter reproduces the user's last layering — the panel that
  // was on top last session is opened last and ends up on top again.
  const tables = (await ctx.store.tables.find()).filter(
    (t) => t.workspaceId === ctx.workspaceId,
  );
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
 * Estimated title-bar height for geometry sanitization at restore time, before
 * the panel exists in the DOM. The live drag clamp measures the real
 * `.jsPanel-titlebar` element. jsPanel's default theme renders ~30–34px;
 * 34 leaves a safe margin so titlebars never restore flush against the
 * footer where they'd be hard to grab.
 */
const TITLEBAR_HEIGHT_ESTIMATE = 34;

/**
 * Validates persisted geometry against the current container bounds.
 *
 * - If `g` is unusable (missing, NaN, too small, or wider than the
 *   container), returns null so the caller falls back to defaults
 *   (cascade + 720x360). A panel taller than the container is allowed —
 *   its body legitimately extends below the footer; only the titlebar
 *   has to remain visible.
 * - If `g` fits dimensionally but its position would push the titlebar
 *   off-screen (e.g. the window was resized smaller between sessions),
 *   x/y are clamped so the titlebar stays inside the container. Size
 *   is preserved.
 *
 * Saved geometry is never overwritten here; this is render-time-only.
 */
function sanitizeGeometry(
  g: WindowGeometry | undefined,
  container: HTMLElement,
): WindowGeometry | null {
  if (!g) return null;
  if (!Number.isFinite(g.w) || !Number.isFinite(g.h)) return null;
  if (g.w < MIN_W || g.h < MIN_H) return null;
  const rect = container.getBoundingClientRect();
  if (g.w > rect.width) return null;
  const x = Math.max(0, Math.min(g.x, rect.width - g.w));
  const y = Math.max(0, Math.min(g.y, rect.height - TITLEBAR_HEIGHT_ESTIMATE));
  return { ...g, x, y };
}

/**
 * Clamp a panel's position so the titlebar stays inside the container,
 * but allow the panel's body to extend below. Called continuously while
 * the user drags so they get immediate visual feedback at the boundary.
 *
 * Horizontal: panel stays fully inside the container width — both edges
 * of the titlebar are visible. Vertical: top edge stays inside, bottom
 * edge may exceed the container so a tall data-table's body can scroll
 * below the footer.
 */
function clampTitlebarInside(panel: HTMLElement, container: HTMLElement): void {
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  const pw = panel.offsetWidth;
  const titlebar = panel.querySelector('.jsPanel-titlebar') as HTMLElement | null;
  const tbH = titlebar?.offsetHeight || TITLEBAR_HEIGHT_ESTIMATE;
  const left = parseFloat(panel.style.left) || panel.offsetLeft || 0;
  const top = parseFloat(panel.style.top) || panel.offsetTop || 0;
  const nextLeft = Math.max(0, Math.min(left, cw - pw));
  const nextTop = Math.max(0, Math.min(top, ch - tbH));
  if (nextLeft !== left) panel.style.left = `${nextLeft}px`;
  if (nextTop !== top) panel.style.top = `${nextTop}px`;
}

function openPanel(t: Table, ctx: AppContext): void {
  const content = document.createElement('data-table');
  (content as HTMLElement & { tableId: string }).tableId = t.id;
  content.style.height = '100%';

  const search = document.createElement('panel-search');
  (search as HTMLElement & { tableId: string }).tableId = t.id;

  const footer = document.createElement('panel-footer');
  (footer as HTMLElement & { tableId: string }).tableId = t.id;

  const container = document.getElementById('easydb-panels') ?? document.body;
  const g = sanitizeGeometry(t.windowGeometry, container);
  const panelId = `panel-${cssSafe(t.id)}`;

  const position = g
    ? { my: 'left-top', at: 'left-top', offsetX: g.x, offsetY: g.y }
    : nextCascadePosition();

  // Saved g.w/g.h come from offsetWidth/Height (total panel size including
  // chrome), so restore via panelSize. New panels use contentSize so the
  // default 720x360 describes the data area, not the chrome.
  const sizeOpt = g
    ? { panelSize: `${g.w} ${g.h}` }
    : { contentSize: `${DEFAULT_W} ${DEFAULT_H}` };

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
    minimizeTo: 'parent',
    // Custom clamping: only the titlebar must stay visible. jsPanel's own
    // `containment: 0` would force the entire panel rect inside the
    // container, which makes tall panels useless once their body has more
    // rows than fit between header and footer. With `containment: false`
    // jsPanel does no clamping and we apply our own in `drag` (per-frame
    // while the user drags) so the body can extend below the footer.
    // Resize gets the same treatment so a user can grow a panel past the
    // bottom too.
    dragit: {
      containment: false,
      drag: (panel: HTMLElement) => clampTitlebarInside(panel, container),
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
          `Delete table "${t.name}" and all its rows?`,
          'Confirm delete',
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
    onstatuschange: () => saveGeometry(t.id, ctx),
  }) as Panel;

  panels.set(t.id, panel);

  // Inject the per-table search into the controlbar (right side of the title
  // row, next to min/max/close) so it shares the title bar instead of taking
  // a second header strip — matches the minniDBMax v1 layout.
  const panelEl = document.getElementById(panelId);
  const controlbar = panelEl?.querySelector('.jsPanel-controlbar');
  if (controlbar) controlbar.prepend(search);

  // Restore minimized/maximized state. Defer to next tick so jsPanel's own
  // init (centering, sizing) finishes before we drive a state change.
  if (g?.maximized && typeof panel.maximize === 'function') {
    queueMicrotask(() => panel.maximize?.());
  } else if (g?.minimized && typeof panel.minimize === 'function') {
    queueMicrotask(() => panel.minimize?.());
  }

  // Live-update the panel header with "<table-name> (<rowCount>)".
  // Subscribing here keeps the data-table component free of jsPanel knowledge.
  let lastName = t.name;
  let unsub: (() => void) | null = null;
  const updateTitle = (count: number) => {
    if (typeof panel.setHeaderTitle === 'function') {
      panel.setHeaderTitle(`${lastName} (${count})`);
    }
  };
  void ctx.store.rows(t.id)
    .find()
    .then((rows) => updateTitle(rows.length));
  unsub = ctx.store.rows(t.id).subscribe((rows) => updateTitle(rows.length));
  void ctx.store.tables.subscribe((all) => {
    const cur = all.find((x) => x.id === t.id);
    if (cur && cur.name !== lastName) {
      lastName = cur.name;
    }
  });
  // Clean up the row subscription on close so it doesn't leak after table delete.
  const origClose = panel.close.bind(panel);
  panel.close = () => {
    unsub?.();
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
  const status = (el as HTMLElement & { dataset: DOMStringMap }).dataset.status ?? 'normalized';
  try {
    const t = await ctx.store.tables.findOne(tableId);
    const prevZ = t?.windowGeometry?.z ?? 0;
    const geom: WindowGeometry = {
      x: el.offsetLeft,
      y: el.offsetTop,
      w: el.offsetWidth,
      h: el.offsetHeight,
      // Preserve the front-order timestamp written by stampFrontOrder.
      // We can't read DOM z meaningfully — jsPanel renormalizes it on every
      // .front() so it's not a stable per-panel identity.
      z: prevZ,
      minimized: status === 'minimized',
      maximized: status === 'maximized',
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
  const rowColl = ctx.store.rows(tableId);
  const rows = await rowColl.find();
  await rowColl.bulkRemove(rows.map((r) => r.id));
  await ctx.store.tables.remove(tableId);
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
