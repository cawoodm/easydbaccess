import type { Row, Setting, Table, ViewInstance, ViewTemplate } from '@easydb/shared';
import { settingId, type EasyDb } from './dexie-db.js';

/**
 * What a new workspace takes over from the one it was created in.
 *
 *  - `all` — tables with their rows, view templates and instances, settings and
 *    the plugin list. A working copy to experiment in.
 *  - `settings` — settings and the plugin list only: same server, same token,
 *    same plugins, no data.
 *  - `empty` — nothing at all.
 *
 * Device-local `user` settings are never involved: they live outside the store
 * (`db/user-settings.ts`) and are global to the device by design.
 */
export type CloneMode = 'all' | 'settings' | 'empty';

function uuid(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

/**
 * Create a workspace and copy the requested slice of `from` into it.
 *
 * Every copied record gets a fresh id, because ids are global, not per-workspace.
 * Rows and view instances are re-pointed at the new table ids through a map built
 * while the tables are copied — a copied row that still referenced the source
 * table would show up in BOTH workspaces.
 *
 * Returns the new workspace id. Caller navigates to it (`?space=`).
 */
export async function cloneWorkspace(
  db: EasyDb,
  opts: { from: string; to: string; name: string; mode: CloneMode },
): Promise<string> {
  const { from, to, name, mode } = opts;
  const source = await db.workspaces.get(from);

  await db.workspaces.put({
    id: to,
    name,
    createdAt: Date.now(),
    // The plugin list decides which plugins load, so it rides along with the
    // settings rather than with the data.
    pluginUrls: mode === 'empty' ? [] : [...(source?.pluginUrls ?? [])],
  });

  if (mode === 'empty') return to;

  if (mode === 'all') {
    const tables = (await db.tables.where('workspaceId').equals(from).toArray()) as Table[];
    const tableIdMap = new Map<string, string>();
    for (const t of tables) {
      const newId = uuid();
      tableIdMap.set(t.id, newId);
      await db.tables.put({ ...t, id: newId, workspaceId: to, updatedAt: Date.now() });
    }
    for (const [oldId, newId] of tableIdMap) {
      const rows = (await db.rows.where('tableId').equals(oldId).toArray()) as Row[];
      if (rows.length > 0) {
        await db.rows.bulkPut(rows.map((r) => ({ ...r, id: uuid(), tableId: newId })));
      }
    }

    const templates = (await db.viewTemplates
      .where('workspaceId')
      .equals(from)
      .toArray()) as ViewTemplate[];
    const templateIdMap = new Map<string, string>();
    for (const vt of templates) {
      const newId = uuid();
      templateIdMap.set(vt.id, newId);
      await db.viewTemplates.put({ ...vt, id: newId, workspaceId: to });
    }

    const instances = (await db.viewInstances
      .where('workspaceId')
      .equals(from)
      .toArray()) as ViewInstance[];
    for (const inst of instances) {
      // A view whose table did not come along would dangle, so skip it.
      const tableId = tableIdMap.get(inst.tableId);
      if (!tableId) continue;
      await db.viewInstances.put({
        ...inst,
        id: uuid(),
        workspaceId: to,
        tableId,
        templateId: templateIdMap.get(inst.templateId) ?? inst.templateId,
      });
    }
  }

  const settings = (await db.settings.where('workspaceId').equals(from).toArray()) as Setting[];
  for (const s of settings) {
    await db.settings.put({ ...s, key: settingId(to, s.name), workspaceId: to, name: s.name });
  }

  return to;
}
