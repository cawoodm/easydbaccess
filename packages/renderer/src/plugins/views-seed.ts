// packages/renderer/src/plugins/views-seed.ts
//
// The built-in View templates, and reconciling them into a workspace.
//
// Split out of `views.ts` for the usual reason this codebase splits things out:
// the plugin imports the Views dialog, which imports the whole element tree, so
// nothing in `views.ts` can be reached from a unit test running in plain Node.
// This half touches only the store, and the rule it has to get right — writing
// NOTHING when there is nothing to do — is exactly the sort of rule a test should
// hold down.

import type { HostApi } from '@easydb/shared';

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
 *
 * Reconciling is READ-ONLY when nothing has changed. It runs on every load, and a
 * write on every load is not free: the store broadcasts it, which marks the
 * workspace unsaved.
 */
export async function seedDefaults(api: HostApi): Promise<void> {
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
    // Only if it is not already recorded. Re-writing a value that has not
    // changed is still a WRITE, and every write marks the workspace unsaved — so
    // these four no-op upserts, one per built-in, are what brought a freshly
    // saved workspace back from a reload with a red dot on Save. Nothing else in
    // a plain boot writes at all.
    if (!(await api.store.settings.findOne(seededKey))?.value) {
      await api.store.settings.upsert({ name: seededKey, value: true });
    }
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
