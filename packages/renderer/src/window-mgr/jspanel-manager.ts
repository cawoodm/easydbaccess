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

/** jsPanel instance — typed loose since the lib ships no .d.ts. */
type Panel = {
  id: string;
  close(): void;
  status: 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
};

const panels = new Map<string, Panel>();
let initialized = false;

export async function initWindowManager(): Promise<void> {
  if (initialized) return;
  initialized = true;

  const ctx = await getContext();

  // Initial population.
  const tables = (await ctx.store.tables.find()).filter(
    (t) => t.workspaceId === ctx.workspaceId,
  );
  for (const t of tables) openPanel(t, ctx);

  // Reactive sync: open new tables' panels, close panels whose tables vanished.
  ctx.store.tables.subscribe((all) => {
    const inWs = all.filter((t) => t.workspaceId === ctx.workspaceId);
    const liveIds = new Set(inWs.map((t) => t.id));

    for (const [id, panel] of panels) {
      if (!liveIds.has(id)) {
        panels.delete(id);
        try {
          if (panel.status !== 'closed') panel.close();
        } catch {
          /* already gone */
        }
      }
    }
    for (const t of inWs) {
      if (!panels.has(t.id)) openPanel(t, ctx);
    }
  });
}

/** Minimum sensible panel dimensions; anything smaller is treated as corrupt. */
const MIN_W = 200;
const MIN_H = 100;
/** Default size for new (or sanity-reset) panels — matches contentSize below. */
const DEFAULT_W = 720;
const DEFAULT_H = 360;

/**
 * Validates persisted geometry against the current container bounds.
 *
 * - If `g` is unusable (missing, NaN, too small, or larger than the container),
 *   returns null so the caller falls back to defaults (cascade + 720x360).
 * - If `g` fits dimensionally but its position would push it off-screen
 *   (e.g. the window was resized smaller between sessions), the x/y are
 *   clamped so the panel stays fully visible. Size is preserved.
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
  if (g.w > rect.width || g.h > rect.height) return null;
  const x = Math.max(0, Math.min(g.x, rect.width - g.w));
  const y = Math.max(0, Math.min(g.y, rect.height - g.h));
  return { ...g, x, y };
}

function openPanel(t: Table, ctx: AppContext): void {
  const content = document.createElement('data-table');
  (content as HTMLElement & { tableId: string }).tableId = t.id;
  content.style.height = '100%';

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
    headerControls: { smallify: 'remove' },
    theme: 'primary',
    content,
    ...sizeOpt,
    position,
    minimizeTo: 'parent',
    dragit: { containment: 0, stop: () => saveGeometry(t.id, ctx) },
    resizeit: { containment: 0, stop: () => saveGeometry(t.id, ctx) },
    onbeforeclose: () => {
      const yes = window.confirm(`Delete table "${t.name}" and all its rows?`);
      return yes;
    },
    onclosed: async () => {
      panels.delete(t.id);
      await deleteTableCascade(t.id, ctx);
    },
    onstatuschange: () => saveGeometry(t.id, ctx),
  }) as Panel;

  panels.set(t.id, panel);
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
  const geom: WindowGeometry = {
    x: el.offsetLeft,
    y: el.offsetTop,
    w: el.offsetWidth,
    h: el.offsetHeight,
    z: parseInt(el.style.zIndex || '0', 10),
    minimized: status === 'minimized',
    maximized: status === 'maximized',
  };
  try {
    await ctx.store.tables.patch(tableId, {
      windowGeometry: geom,
      updatedAt: Date.now(),
    });
  } catch {
    // Table might have just been deleted — ignore.
  }
}

async function deleteTableCascade(tableId: string, ctx: AppContext): Promise<void> {
  const rows = await ctx.store.rows(tableId).find();
  for (const r of rows) await ctx.store.rows(tableId).remove(r.id);
  await ctx.store.tables.remove(tableId);
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
