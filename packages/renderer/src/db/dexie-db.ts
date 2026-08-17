import Dexie, { type Table as DexieTable } from 'dexie';
import { settingId, type PluginRecord, type Row, type Setting, type Table, type ViewInstance, type ViewTemplate, type Workspace } from '@easydb/shared';

/**
 * easyDB local store: one IndexedDB database, one Dexie table per logical
 * collection. Schema strings follow Dexie's syntax — leading column is the
 * primary key; subsequent comma-separated columns are secondary indexes.
 *
 * Versioning: bump `db.version(N)` each time a schema field needs to be
 * indexed/unindexed. Column-shape evolution (rewriting existing rows on the
 * way up) is handled inside `.upgrade()` callbacks.
 *
 * The DB is exposed as plain Dexie (no subclass) because `Dexie.tables` is
 * already an instance member on the base class — subclassing would force a
 * rename. Typed accessors live on `EasyDb` below.
 */

const DB_NAME = 'easydb';

export interface EasyDb {
  raw: Dexie;
  workspaces: DexieTable<Workspace, string>;
  tables: DexieTable<Table, string>;
  rows: DexieTable<Row, string>;
  settings: DexieTable<Setting, string>;
  plugins: DexieTable<PluginRecord, string>;
  viewTemplates: DexieTable<ViewTemplate, string>;
  viewInstances: DexieTable<ViewInstance, string>;
}

let instance: EasyDb | null = null;

export function getDexie(): EasyDb {
  if (instance) return instance;

  const raw = new Dexie(DB_NAME);
  raw.version(1).stores({
    workspaces: 'id',
    tables: 'id, workspaceId, updatedAt',
    rows: 'id, tableId, updatedAt',
    settings: 'key',
    plugins: 'url',
  });
  // v2 adds the View system's two collections. Dexie carries forward the v1
  // tables; only the added stores are declared here. No data migration needed.
  raw.version(2).stores({
    viewTemplates: 'id, workspaceId',
    viewInstances: 'id, workspaceId, tableId',
  });
  // v3 scopes settings to a workspace. Until now one global `settings` store was
  // shared by every workspace, so a new workspace inherited the old one's server
  // URL, tokens and view-seed flags. The primary key becomes the composite
  // `<workspaceId>::<name>` (built by `settingId`) with `workspaceId`/`name`
  // indexed for lookups; the store name and its `key` primary key stay, so no
  // store has to be dropped and recreated.
  //
  // Migration copies every old setting into EVERY existing workspace: each
  // workspace keeps exactly the values it saw before the upgrade, and only later
  // edits diverge.
  raw
    .version(3)
    .stores({ settings: 'key, workspaceId, name' })
    .upgrade(async (tx) => {
      const settings = tx.table('settings');
      const old = (await settings.toArray()) as Array<{
        key: string;
        workspaceId?: string;
        name?: string;
        value: unknown;
      }>;
      // Already-scoped rows would be re-keyed a second time on a repeated upgrade.
      const legacy = old.filter((s) => s.workspaceId == null);
      if (legacy.length === 0) return;
      const workspaceIds = ((await tx.table('workspaces').toArray()) as Array<{ id: string }>).map((w) => w.id);
      // No workspace yet (a fresh DB that somehow holds settings): nothing to scope
      // them to, and app-context creates `default` right after this.
      const targets = workspaceIds.length > 0 ? workspaceIds : ['default'];
      for (const s of legacy) {
        for (const workspaceId of targets) {
          await settings.put({ key: settingId(workspaceId, s.key), workspaceId, name: s.key, value: s.value });
        }
        await settings.delete(s.key);
      }
    });

  // Multi-tab schema-upgrade safety. A schema bump (new object stores) can only
  // run in an IndexedDB `versionchange` transaction, which is BLOCKED while any
  // other tab still holds the DB open at the old version. Without handling that,
  // the newer tab's `open()` hangs forever on a blank screen (the "completely
  // broken after an upgrade" symptom).
  //
  //  - `versionchange`: another connection needs to change the DB's version.
  //    Close ours so we stop blocking it. If it's an UPGRADE (another tab
  //    shipped a newer schema — `newVersion` is set), also reload so this tab
  //    comes back on the new code instead of running against a dead handle. If
  //    it's a DELETE (`newVersion === null`, e.g. an app-driven reset), just
  //    yield — reloading there would fight the deletion / loop.
  //  - `blocked`: OUR open is blocked by an older tab that hasn't yielded.
  //    Surface an actionable message instead of hanging silently.
  raw.on('versionchange', (event) => {
    try {
      raw.close();
    } catch {
      /* ignore */
    }
    const upgrading = (event as IDBVersionChangeEvent)?.newVersion != null;
    if (upgrading && typeof location !== 'undefined') location.reload();
  });
  raw.on('blocked', () => showUpgradeBlocked());

  instance = {
    raw,
    workspaces: raw.table<Workspace, string>('workspaces'),
    tables: raw.table<Table, string>('tables'),
    rows: raw.table<Row, string>('rows'),
    settings: raw.table<Setting, string>('settings'),
    plugins: raw.table<PluginRecord, string>('plugins'),
    viewTemplates: raw.table<ViewTemplate, string>('viewTemplates'),
    viewInstances: raw.table<ViewInstance, string>('viewInstances'),
  };
  return instance;
}

/**
 * Full-screen message shown when a database upgrade is blocked by another tab
 * running an older version — turns a silent, blank hang into clear guidance.
 * Idempotent (only injected once).
 */
function showUpgradeBlocked(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('easydb-upgrade-blocked')) return;
  const el = document.createElement('div');
  el.id = 'easydb-upgrade-blocked';
  el.setAttribute('role', 'alertdialog');
  el.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;' + 'justify-content:center;background:rgba(15,23,42,0.55);' + 'font-family:system-ui,sans-serif;padding:1rem;';
  el.innerHTML =
    '<div style="max-width:26rem;background:#fff;border-radius:0.6rem;padding:1.5rem 1.75rem;' +
    'box-shadow:0 20px 50px rgba(0,0,0,0.3);text-align:center;">' +
    '<h2 style="margin:0 0 0.5rem;font-size:1.1rem;color:#111827;">Update in progress</h2>' +
    '<p style="margin:0 0 1rem;color:#374151;font-size:0.9rem;line-height:1.5;">' +
    'easyDBAccess needs to upgrade its local database, but an <strong>older version is still ' +
    'open in another tab or window</strong>. Close the other easyDBAccess tabs, then reload.</p>' +
    '<button id="easydb-upgrade-reload" style="font:inherit;background:#3b82f6;color:#fff;' +
    'border:0;padding:0.5rem 1rem;border-radius:0.3rem;cursor:pointer;">Reload</button></div>';
  document.body.appendChild(el);
  el.querySelector('#easydb-upgrade-reload')?.addEventListener('click', () => location.reload());
}
