// Restoring the view templates carried by a workspace dump or a Gist marker
// file. Both paths (plugins/json-import.ts and plugins/gist-sync.ts) call
// `restoreTemplates` so they resolve a template the same way.
//
// Why this is not a plain upsert-by-id: views.ts seeds each built-in template
// with a fresh `uuid()` PER WORKSPACE, so the "Gallery" of the device that
// wrote the dump and the "Gallery" of the device reading it have different ids
// but the same name. Upserting by id therefore inserted a second "Gallery"
// next to the local one on every import. A template is identified by its NAME
// inside a workspace (the Views dialog already refuses duplicate names), so
// that is what we match on.

import type { DataCollection, ViewTemplate } from '@easydb/shared';

/**
 * Upserts `incoming` into `coll` for one workspace, overwriting a local
 * template of the same name instead of adding a duplicate.
 *
 * Returns the id remap `dump id -> local id`, which the caller MUST apply to
 * every view instance's `templateId`. Without it an instance would keep
 * pointing at the dump's id, which was never written, and its window would
 * open with no template.
 */
export async function restoreTemplates(coll: DataCollection<ViewTemplate>, workspaceId: string, incoming: ViewTemplate[]): Promise<Map<string, string>> {
  const remap = new Map<string, string>();
  if (incoming.length === 0) return remap;

  const local = (await coll.find()).filter((t) => t.workspaceId === workspaceId);
  const byName = new Map(local.map((t) => [t.name, t] as const));
  const byId = new Map(local.map((t) => [t.id, t] as const));

  for (const vt of incoming) {
    if (!isTemplate(vt)) continue;
    // Name first, id second: the same name is the same template even across
    // devices, and an id match only helps when the dump came from HERE.
    const match = byName.get(vt.name) ?? byId.get(vt.id);
    const id = match?.id ?? vt.id;
    if (match) remap.set(vt.id, match.id);
    // The local record decides whether this is a built-in. A dump cannot turn
    // a user template into a built-in one (which would then be reconciled
    // against the shipped HTML on the next load) or the other way round.
    const builtin = match ? match.builtin : vt.builtin;
    const doc: ViewTemplate = { ...vt, id, workspaceId };
    if (builtin === undefined) delete doc.builtin;
    else doc.builtin = builtin;
    await coll.upsert(doc);
    // Two incoming templates sharing a name must collapse onto one record, so
    // keep the maps current as we go.
    byName.set(doc.name, doc);
    byId.set(doc.id, doc);
  }

  return remap;
}

function isTemplate(v: unknown): v is ViewTemplate {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as Partial<ViewTemplate>;
  return typeof t.id === 'string' && typeof t.name === 'string';
}
