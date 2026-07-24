// packages/renderer/src/plugins/views.ts
//
// The View system (built-in plugin).
//
//   • A ViewTemplate (workspace-global) is header/row/footer HTML that decides
//     how a table is displayed. Blank row HTML ⇒ a read-only columns table;
//     otherwise the row HTML repeats per row with $TOKEN placeholders.
//   • A ViewInstance ties a template to ONE table, snapshotting its sort /
//     filter / visible columns and mapping the template's $TOKENs to columns.
//     It opens read-only in its own window.
//
// This plugin: seeds the default "RSS Feed" template, adds a "Views" button to
// each table's footer (opening the manager dialog), and opens/closes the
// read-only view windows.

// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';
import type { HostApi, PluginModule } from '@easydb/shared';
import { openViewsDialog } from '../dialogs/views-dialog.js';
import '../views/view-window.js';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'views',
  version: '0.1.0',
  description: 'Display tables through HTML view templates in read-only windows.',
  author: 'easyDBAccess built-ins',
  optional: true,
};

// Footer/table buttons render their `icon` as a Material Icons ligature (see
// panel-footer.ts) — NOT as raw SVG (that's the header-button convention). Use
// the icon name here so it renders as a glyph instead of garbled markup.
const VIEWS_ICON = 'grid_view';

// --- Default RSS template ----------------------------------------------------
const RSS_NAME = 'RSS Feed';
const RSS_HEADER = '<div style="display:flex;flex-direction:column;gap:12px;padding:12px;">';
const RSS_ROW = [
  '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 16px;background:#ffffff;box-shadow:0 1px 2px rgba(0,0,0,0.06);">',
  '<a href="$URL" target="_blank" rel="noopener noreferrer" style="font-size:1.05rem;font-weight:600;color:#2563eb;text-decoration:none;">$TITLE</a>',
  '<div style="color:#6b7280;font-size:0.78rem;margin:4px 0;">$DATE</div>',
  '<div style="color:#374151;font-size:0.9rem;line-height:1.45;">$DESCRIPTION</div>',
  '</div>',
].join('');
const RSS_FOOTER = '</div>';

export function init(api: HostApi): void {
  // Footer "Views" icon on every table.
  api.ui.registerTableButton({
    id: 'views:open',
    label: 'Views',
    icon: VIEWS_ICON,
    tooltip: 'Views — display this table through a template',
    onClick: (_a, { tableId }) => openViewsDialog(tableId),
  });

  document.addEventListener('easydb:open-view', (e) => {
    const id = (e as CustomEvent<{ instanceId: string }>).detail?.instanceId;
    if (id) void openViewWindow(api, id);
  });
  document.addEventListener('easydb:close-view', (e) => {
    const id = (e as CustomEvent<{ instanceId: string }>).detail?.instanceId;
    if (id) closeViewWindow(id);
  });
}

export async function load(api: HostApi): Promise<void> {
  await seedDefaults(api);
}

/** Seed the built-in RSS template once per workspace (never re-seeds if deleted). */
async function seedDefaults(api: HostApi): Promise<void> {
  const wsId = api.workspaceId();
  if (!wsId) return;
  const flagKey = `views:seeded:rss:${wsId}`;
  const flag = await api.store.settings.findOne(flagKey);
  if (flag?.value) return;
  const already = (await api.store.viewTemplates.find({ workspaceId: wsId })).some(
    (t) => t.builtin && t.name === RSS_NAME,
  );
  if (!already) {
    await api.store.viewTemplates.insert({
      id: uuid(),
      workspaceId: wsId,
      name: RSS_NAME,
      headerHtml: RSS_HEADER,
      rowHtml: RSS_ROW,
      footerHtml: RSS_FOOTER,
      builtin: true,
      updatedAt: Date.now(),
    });
  }
  await api.store.settings.upsert({ key: flagKey, value: true });
}

// --- View windows ------------------------------------------------------------

type Panel = { front?: () => void; close?: () => void };
const openPanels = new Map<string, Panel>();

function viewContainer(): HTMLElement {
  return (
    document.getElementById('easydb-panels-viewport') ??
    document.getElementById('easydb-panels') ??
    document.body
  );
}

async function openViewWindow(api: HostApi, instanceId: string): Promise<void> {
  const existing = openPanels.get(instanceId);
  if (existing) {
    try {
      existing.front?.();
    } catch {
      /* ignore */
    }
    return;
  }
  const inst = await api.store.viewInstances.findOne(instanceId);
  if (!inst) return;

  const el = document.createElement('view-window') as HTMLElement & { viewInstanceId: string };
  el.viewInstanceId = instanceId;
  el.style.height = '100%';

  const g = inst.windowGeometry;
  const panelId = `view-panel-${cssSafe(instanceId)}`;
  const sizeOpt = g ? { panelSize: `${g.w} ${g.h}` } : { contentSize: '480 520' };
  const position = g
    ? { my: 'left-top', at: 'left-top', offsetX: g.x, offsetY: g.y }
    : { my: 'center-top', at: 'center-top', offsetY: 60 };

  const panel = jsPanel.create({
    id: panelId,
    container: viewContainer(),
    headerTitle: inst.name,
    // A distinct cyan chrome so view windows read as different from tables.
    theme: '#0891b2',
    content: el,
    ...sizeOpt,
    position,
    dragit: { containment: false, stop: () => void saveViewGeometry(api, instanceId, panelId) },
    resizeit: { containment: false, stop: () => void saveViewGeometry(api, instanceId, panelId) },
    onclosed: () => {
      openPanels.delete(instanceId);
    },
  }) as Panel;
  openPanels.set(instanceId, panel);
}

function closeViewWindow(instanceId: string): void {
  const panel = openPanels.get(instanceId);
  if (!panel) return;
  openPanels.delete(instanceId);
  try {
    panel.close?.();
  } catch {
    /* already gone */
  }
}

async function saveViewGeometry(api: HostApi, instanceId: string, panelId: string): Promise<void> {
  const el = document.getElementById(panelId);
  if (!el) return;
  try {
    await api.store.viewInstances.patch(instanceId, {
      windowGeometry: {
        x: el.offsetLeft,
        y: el.offsetTop,
        w: el.offsetWidth,
        h: el.offsetHeight,
        z: 0,
        minimized: false,
        maximized: false,
      },
      updatedAt: Date.now(),
    });
  } catch {
    /* instance may have been deleted — ignore */
  }
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
