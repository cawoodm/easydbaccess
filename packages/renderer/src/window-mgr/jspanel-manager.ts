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

function openPanel(t: Table, ctx: AppContext): void {
  const content = document.createElement('data-table');
  (content as HTMLElement & { tableId: string }).tableId = t.id;
  content.style.height = '100%';

  const g = t.windowGeometry;
  const panelId = `panel-${cssSafe(t.id)}`;

  const position = g
    ? { my: 'left-top', at: 'left-top', offsetX: g.x, offsetY: g.y }
    : nextCascadePosition();

  const panel = jsPanel.create({
    id: panelId,
    headerTitle: t.name,
    headerControls: { smallify: 'remove' },
    theme: 'primary',
    content,
    contentSize: g ? `${g.w} ${g.h}` : '720 360',
    position,
    dragit: { stop: () => saveGeometry(t.id, ctx) },
    resizeit: { stop: () => saveGeometry(t.id, ctx) },
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
