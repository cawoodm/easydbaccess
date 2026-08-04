// packages/renderer/src/plugins/views.ts
//
// The View system (built-in plugin).
//
//   - A ViewTemplate (workspace-global) is header/row/footer HTML that decides
//     how a table is displayed. Blank row HTML => a read-only columns table;
//     otherwise the row HTML repeats per row with $TOKEN placeholders. A
//     $input.TOKEN renders an editable control bound to the mapped column.
//   - A ViewInstance ties a template to ONE table, snapshotting its sort /
//     filter / visible columns and mapping the template's $TOKENs to columns.
//     It opens in its own window.
//
// This plugin owns only DATA + INTENT: it seeds the default templates and adds
// a "Views" button to each table's footer (opening the manager dialog). The
// actual view *windows* -- opening, geometry, persistence, maximize behaviour,
// and boot-time restore -- are owned by the CORE window manager
// (`window-mgr/view-window-manager.ts`), driven by the `ViewInstance.open` flag
// the dialog flips. Plugins must not manage windows themselves.

import type { HostApi, PluginModule } from '@easydb/shared';
import { openViewsDialog } from '../dialogs/views-dialog.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'views',
  name: 'Views',
  type: 'ui',
  version: '0.1.0',
  description: 'Display tables through HTML view templates in read-only windows.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/views.ts',
};

// Footer/table buttons render their `icon` as a Material Icons ligature (see
// panel-footer.ts) -- NOT as raw SVG (that's the header-button convention). Use
// the icon name here so it renders as a glyph instead of garbled markup.
const VIEWS_ICON = 'grid_view';

// --- Built-in templates ------------------------------------------------------
// Each is reconciled into the workspace on load (see seedDefaults). `slug` keys
// its per-workspace "seeded"/"signature" settings; keep it stable. `rss` MUST
// stay `rss` so already-seeded workspaces are not re-seeded.

interface BuiltinTemplate {
  slug: string;
  name: string;
  header: string;
  row: string;
  footer: string;
}

// RSS Feed: a linked card per row with a date, a clamped description, and two
// editable flag checkboxes ($input.CHECK1/CHECK2 auto-map to the first two
// boolean columns).
const RSS: BuiltinTemplate = {
  slug: 'rss',
  name: 'RSS Feed',
  header: '<div style="display:flex;flex-direction:column;gap:12px;padding:12px;">',
  row: [
    '<div style="border:1px solid #e5e7eb;border-radius:12px;padding:12px 16px;background:#ffffff;box-shadow:0 1px 2px rgba(0,0,0,0.06);">',
    '<a href="$URL" target="_blank" rel="noopener noreferrer" style="font-size:1.05rem;font-weight:600;color:#2563eb;text-decoration:none;">$TITLE</a>',
    '<div style="color:#6b7280;font-size:0.78rem;margin:4px 0;">$DATE</div>',
    '<div style="color:#374151;font-size:0.9rem;line-height:1.45;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:20;line-clamp:20;overflow:hidden;">$DESCRIPTION</div>',
    '<div style="display:flex;gap:16px;margin-top:8px;">$input.CHECK1$input.CHECK2</div>',
    '</div>',
  ].join(''),
  footer: '</div>',
};

// Todo List: a checklist. $input.DONE (mapped to the first boolean column) is a
// tick that writes straight back; combine with a "!true" filter on that column
// for a self-clearing list.
const TODO: BuiltinTemplate = {
  slug: 'todo-list',
  name: 'Todo List',
  header: '<div style="display:flex;flex-direction:column;gap:6px;padding:12px;max-width:720px;margin:0 auto;">',
  row: [
    '<div style="display:flex;align-items:center;gap:10px;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;background:#ffffff;">',
    '$input.DONE',
    '<span style="flex:1;font-weight:500;color:#111827;">$TITLE</span>',
    '<span style="color:#6b7280;font-size:0.8rem;white-space:nowrap;">$DUE</span>',
    '</div>',
  ].join(''),
  footer: '</div>',
};

// Gallery: a responsive grid of image cards. $IMAGE is the <img> src; $LINK makes
// the whole card open its row's URL in a new tab (same shape as RSS's $URL).
const GALLERY: BuiltinTemplate = {
  slug: 'gallery',
  name: 'Gallery',
  header: '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:12px;">',
  row: [
    '<figure style="margin:0;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;background:#ffffff;box-shadow:0 1px 2px rgba(0,0,0,0.06);">',
    '<a href="$LINK" target="_blank" rel="noopener noreferrer" style="display:block;text-decoration:none;color:inherit;">',
    '<img src="$IMAGE" alt="$TITLE" loading="lazy" style="width:100%;height:150px;object-fit:cover;display:block;background:#f3f4f6;" />',
    '<figcaption style="padding:6px 8px;font-size:0.85rem;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">$TITLE</figcaption>',
    '</a>',
    '</figure>',
  ].join(''),
  footer: '</div>',
};

// Contact Cards: a grid of people, name + a mailto: email link + phone.
const CONTACTS: BuiltinTemplate = {
  slug: 'contact-cards',
  name: 'Contact Cards',
  header: '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;padding:12px;">',
  row: [
    '<div style="border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;background:#ffffff;box-shadow:0 1px 2px rgba(0,0,0,0.06);">',
    '<div style="font-weight:600;color:#111827;font-size:0.95rem;">$NAME</div>',
    '<a href="mailto:$EMAIL" style="color:#2563eb;text-decoration:none;font-size:0.85rem;word-break:break-all;">$EMAIL</a>',
    '<div style="color:#6b7280;font-size:0.85rem;margin-top:2px;">$PHONE</div>',
    '</div>',
  ].join(''),
  footer: '</div>',
};

const BUILTINS: BuiltinTemplate[] = [RSS, TODO, GALLERY, CONTACTS];

export function init(api: HostApi): void {
  // Footer "Views" icon on every table. Everything past opening the dialog is
  // core: the dialog flips `ViewInstance.open` and the core view-window manager
  // opens/closes/persists the windows.
  api.ui.registerTableButton({
    id: 'views:open',
    label: 'Views',
    icon: VIEWS_ICON,
    tooltip: 'Views -- display this table through a template',
    onClick: (_a, { tableId }) => openViewsDialog(tableId),
  });
}

export async function load(api: HostApi): Promise<void> {
  await seedDefaults(api);
}

/** Content signature for a built-in template. Changes whenever its shipped
 *  header/row/footer HTML changes, so an already-seeded workspace can be told
 *  its copy is out of date and updated in place. */
function signatureOf(t: BuiltinTemplate): string {
  let h = 5381;
  const s = `${t.header} ${t.row} ${t.footer}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Ensure the built-in templates exist and match the shipped HTML.
 *
 * Templates live in the workspace's IndexedDB, so a new app release does NOT
 * automatically update a workspace seeded by an earlier version. We reconcile
 * every built-in on every load: seed it once for a fresh workspace, and -- when
 * the shipped HTML changes (new signature) -- patch the existing built-in copy
 * so fixes reach workspaces that already have it. A workspace where the user
 * deleted a built-in is left alone (the per-slug "seeded" flag records that we
 * provisioned it once).
 */
async function seedDefaults(api: HostApi): Promise<void> {
  const wsId = api.workspaceId();
  if (!wsId) return;
  const existing = await api.store.viewTemplates.find({ workspaceId: wsId });
  for (const t of BUILTINS) {
    await reconcileBuiltin(api, wsId, t, existing);
  }
}

async function reconcileBuiltin(api: HostApi, wsId: string, t: BuiltinTemplate, existing: Awaited<ReturnType<HostApi['store']['viewTemplates']['find']>>): Promise<void> {
  const seededKey = `views:seeded:${t.slug}:${wsId}`;
  const sigKey = `views:sig:${t.slug}:${wsId}`;
  const shipped = signatureOf(t);
  const present = existing.find((x) => x.builtin && x.name === t.name);

  if (present) {
    const appliedSig = (await api.store.settings.findOne(sigKey))?.value;
    if (appliedSig !== shipped) {
      // Shipped HTML changed since this workspace last saw it -- update in place.
      await api.store.viewTemplates.patch(present.id, {
        headerHtml: t.header,
        rowHtml: t.row,
        footerHtml: t.footer,
        updatedAt: Date.now(),
      });
      await api.store.settings.upsert({ name: sigKey, value: shipped });
    }
    await api.store.settings.upsert({ name: seededKey, value: true });
    return;
  }

  // Not present. Only seed if we never have (respect a user who deleted it).
  const seeded = await api.store.settings.findOne(seededKey);
  if (seeded?.value) return;
  await api.store.viewTemplates.insert({
    id: uuid(),
    workspaceId: wsId,
    name: t.name,
    headerHtml: t.header,
    rowHtml: t.row,
    footerHtml: t.footer,
    builtin: true,
    updatedAt: Date.now(),
  });
  await api.store.settings.upsert({ name: seededKey, value: true });
  await api.store.settings.upsert({ name: sigKey, value: shipped });
}

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
