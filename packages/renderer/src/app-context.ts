import type { DataStore, EventBus, HostApi, RowSourceCtx, Table } from '@easydb/shared';
import { createDataStore, createRoutedDataStore, getDb } from './db/index.js';
import { createEventBus } from './events/bus.js';
import { createRegistries, type Registries } from './plugin-host/registries.js';
import { createHostApi } from './plugin-host/api-factory.js';
import { loadBuiltinPlugins } from './plugin-host/loader.js';
import { registerCoreCommands } from './plugin-host/core-commands.js';
import { loadUrlPlugins } from './plugin-host/url-loader.js';
import { SAFE_MODE } from './plugin-host/safe-mode.js';

export interface AppContext {
  store: DataStore;
  events: EventBus;
  workspaceId: string;
  registries: Registries;
  api: HostApi;
}

let ctxPromise: Promise<AppContext> | null = null;

export function getContext(): Promise<AppContext> {
  if (!ctxPromise) ctxPromise = init();
  return ctxPromise;
}

async function init(): Promise<AppContext> {
  const db = await getDb();
  const baseStore = createDataStore(db);
  const events = createEventBus();
  const registries = createRegistries();

  // Row-source routing (Phase 2a): tables that declare a `source` are backed
  // by a registered provider instead of Dexie. `rows(tableId)` needs the
  // Table synchronously, so keep a cache primed from a live subscription. A
  // cache miss falls through to the local path, so local tables — and the
  // window before the cache warms — behave exactly as before.
  const tableCache = new Map<string, Table>();
  baseStore.tables.subscribe((all) => {
    tableCache.clear();
    for (const t of all) tableCache.set(t.id, t);
  });

  // Seed the cache synchronously the instant a table is inserted/updated —
  // before the async subscription above can fire. A freshly-connected live
  // table (source-backed) must be routable the moment its grid panel reads
  // `rows(id)`; otherwise the panel binds to the empty *local* collection and
  // shows its columns but no rows until the next subscription tick (the
  // "Connect shows no rows" bug — Import is unaffected as it has no `source`).
  const cachingTables: typeof baseStore.tables = {
    ...baseStore.tables,
    insert: (doc) => {
      tableCache.set(doc.id, doc);
      return baseStore.tables.insert(doc);
    },
    upsert: (doc) => {
      tableCache.set(doc.id, doc);
      return baseStore.tables.upsert(doc);
    },
  };

  // Providers created lazily at `rows()` time need `backend.fetch`, which is
  // built on the HostApi below. Expose it through a getter so the ctx can be
  // constructed before the api without a second backend implementation.
  let apiRef: HostApi | null = null;
  const rowSourceCtx: RowSourceCtx = {
    get backend() {
      if (!apiRef) throw new Error('[host] row-source ctx used before app init completed');
      return apiRef.backend;
    },
    events,
    settings: baseStore.settings,
    workspaceId: () => workspaceId,
  };

  const store = createRoutedDataStore({
    base: { ...baseStore, tables: cachingTables },
    providers: registries.rowSources,
    tableById: (id) => tableCache.get(id),
    ctx: rowSourceCtx,
  });

  // Workspace resolution priority:
  //   1. ?space=NAME URL param — if a matching workspace exists, use it.
  //                              If not, create one with that id+name.
  //   2. The last-active workspace (persisted device-local) if it still exists.
  //      This is what makes opening the app in a NEW TAB (a bare URL with no
  //      ?space=) show the workspace you were last using — otherwise it fell
  //      back to the first workspace, which reads as "my data is gone".
  //   3. Otherwise, the first workspace in the store.
  //   4. Otherwise, create a "default" workspace.
  const requested = readWorkspaceFromUrl();
  const existing = await store.workspaces.find();
  let workspaceId: string;
  if (requested) {
    const id = slugifyWorkspace(requested);
    const hit = existing.find((w) => w.id === id || w.name === requested);
    if (hit) {
      workspaceId = hit.id;
    } else {
      const created = await store.workspaces.insert({
        id,
        name: requested,
        createdAt: Date.now(),
        pluginUrls: [],
      });
      workspaceId = created.id;
    }
  } else {
    const last = readLastWorkspace();
    const lastHit = last ? existing.find((w) => w.id === last) : undefined;
    if (lastHit) {
      workspaceId = lastHit.id;
    } else if (existing.length > 0) {
      workspaceId = existing[0]!.id;
    } else {
      const ws = await store.workspaces.insert({
        id: 'default',
        name: 'default',
        createdAt: Date.now(),
        pluginUrls: [],
      });
      workspaceId = ws.id;
    }
  }

  // Remember the active workspace so a fresh tab / reload without ?space= comes
  // back to it (see resolution step 2 above).
  persistLastWorkspace(workspaceId);

  const api = createHostApi({
    store,
    events,
    registries,
    workspaceId: () => workspaceId,
  });
  apiRef = api;

  // Core (non-plugin) commands for the Ctrl+K palette — registered before
  // plugins so the window-management commands are always present.
  registerCoreCommands(api);

  // Centralized import-status toasts so every importer (csv, json, gist pull,
  // future ones) gets consistent UX without duplicating the toast call.
  // datasette-source is the exception: it emits its own batch-aware summary
  // (one toast for a whole multi-table import), so we skip the generic
  // per-table toast here to avoid two messages for a single import.
  events.on('import:after', ({ source, tableId, rowCount }) => {
    if (source === 'datasette') return;
    void api.store.tables.findOne(tableId).then((t) => {
      api.ui.dialogs.toast(
        `Imported ${rowCount} row${rowCount === 1 ? '' : 's'} into "${t?.name ?? tableId}".`,
        { kind: 'success', title: source.toUpperCase() + ' import' },
      );
    });
  });
  events.on('plugin:error', ({ url, phase, error }) => {
    api.ui.dialogs.toast(`[${phase}] ${(error as Error)?.message ?? String(error)}`, {
      kind: 'error',
      title: `Plugin: ${url}`,
    });
  });

  // init() built-ins synchronously, then trigger load() after we emit app:ready.
  // URL plugins are loaded after built-ins so the latter establish the host
  // surface (default cell renderers, importers, etc.) before user code runs.
  const runLoadBuiltins = await loadBuiltinPlugins(api);
  const runLoadUrls = await loadUrlPlugins(api);

  queueMicrotask(async () => {
    events.emit('app:ready', { workspaceId });
    await runLoadBuiltins();
    await runLoadUrls();

    // Safe mode is transient (see plugin-host/safe-mode.ts) — it never
    // touches persisted state, so the user could otherwise have no idea why
    // plugins/features are missing. Fire the warning after the load passes
    // above so `toast-host` (mounted in app-shell's initial render, long
    // before this microtask runs) is definitely ready.
    if (SAFE_MODE === 'all-optional') {
      api.ui.dialogs.toast(
        'Safe mode is ON: only fixed built-ins (Settings, core rendering) loaded. ' +
          'All other built-in plugins and URL-installed plugins are disabled for this ' +
          'session only — nothing was changed. Use the Plugin Manager to disable the ' +
          'culprit, then reload without ?safemode.',
        { kind: 'warning', title: 'Safe mode' },
      );
    } else if (SAFE_MODE === 'url-plugins') {
      api.ui.dialogs.toast(
        'Safe mode (URL plugins) is ON: URL-installed plugins were not loaded this ' +
          'session. Built-in plugins are unaffected. Reload without ?safemode1 to restore them.',
        { kind: 'warning', title: 'Safe mode' },
      );
    }
  });

  return { store, events, workspaceId, registries, api };
}

function readWorkspaceFromUrl(): string | null {
  if (typeof location === 'undefined') return null;
  const sp = new URLSearchParams(location.search);
  const v = sp.get('space');
  return v && v.trim().length > 0 ? v.trim() : null;
}

/** Device-local key holding the id of the workspace last opened on this origin. */
const LAST_WORKSPACE_KEY = 'eda:lastWorkspaceId';

function readLastWorkspace(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAST_WORKSPACE_KEY) ?? null;
  } catch {
    return null; // localStorage can throw (private mode / disabled) — ignore.
  }
}

function persistLastWorkspace(id: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    /* ignore — persistence is best-effort */
  }
}

function slugifyWorkspace(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}
