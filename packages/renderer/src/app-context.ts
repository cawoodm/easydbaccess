import type { DataStore, EventBus, HostApi, RowSourceCtx, Table } from '@easydb/shared';
import { createRoutedDataStore, withUniqueTableNames } from './db/index.js';
import { createIpcDataStore } from './db/data-store-bridge.js';
import { startEdbSession, type EdbSession } from './db/edb/session.js';
import { showStorageFailure } from './chrome/storage-failure.js';
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

/**
 * Start the browser's SQLite session, or put a blocking notice on screen.
 *
 * There is no second store to fall back to, so a failure here is fatal by
 * design. The notice goes up BEFORE the rejection propagates, because the
 * rejection alone would leave a blank page — `getContext()` is awaited by every
 * component and nothing else is watching for it.
 */
async function startSessionOrExplain(): Promise<EdbSession> {
  try {
    return await startEdbSession();
  } catch (err) {
    showStorageFailure(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

export function getContext(): Promise<AppContext> {
  if (!ctxPromise) ctxPromise = init();
  return ctxPromise;
}

async function init(): Promise<AppContext> {
  // Settings are workspace-scoped, but the active workspace is resolved further
  // down using this very store — so the store reads the id through this holder,
  // which is filled before any settings access happens.
  let activeWorkspaceId = '';
  // SQLite everywhere, over one adapter. `EdbBridge` implements the same
  // `EasydbStoreBridge` the Electron preload does, so a worker running
  // sqlite-wasm and a preload talking to the main process are the same shape to
  // everything downstream — routing, workspace resolution and the plugin host
  // all see one store.
  //
  // The two differ only in WHERE the database lives: a file the desktop opened,
  // or this tab's own SQLite database (`LOCAL_DB_NAME`, or a `.edb` the user
  // adopted). Persistence is a separate concern from being in SQL mode — the
  // database is live and queryable whether or not anything has been written to
  // disk yet.
  const baseStore = window.easydb?.store ? createIpcDataStore(window.easydb.store, () => activeWorkspaceId) : createIpcDataStore((await startSessionOrExplain()).bridge, () => activeWorkspaceId);
  const events = createEventBus();
  const registries = createRegistries();

  // Row-source routing (Phase 2a): tables that declare a `source` are backed
  // by a registered provider instead of the local database. `rows(tableId)` needs the
  // Table synchronously, so keep a cache primed from a live subscription. A
  // cache miss falls through to the local path, so local tables — and the
  // window before the cache warms — behave exactly as before.
  const tableCache = new Map<string, Table>();
  baseStore.tables.subscribe((all) => {
    tableCache.clear();
    for (const t of all) tableCache.set(t.id, t);
  });

  // Seed the cache the instant a table is inserted/updated — the caller's
  // `await` returns with it already cached, without waiting for the async
  // subscription above. A freshly-connected live
  // table (source-backed) must be routable the moment its grid panel reads
  // `rows(id)`; otherwise the panel binds to the empty *local* collection and
  // shows its columns but no rows until the next subscription tick (the
  // "Connect shows no rows" bug — Import is unaffected as it has no `source`).
  //
  // Both hops go through `withUniqueTableNames`, which is what stops any writer
  // from creating a second table under a name this workspace already uses. The
  // cache is seeded from what the guard actually STORED (a uniqued name), not
  // from what the caller asked for.
  const uniqueTables = withUniqueTableNames(baseStore.tables);
  const cachingTables: typeof baseStore.tables = {
    ...uniqueTables,
    insert: async (doc) => {
      const stored = await uniqueTables.insert(doc);
      tableCache.set(stored.id, stored);
      return stored;
    },
    upsert: async (doc) => {
      const stored = await uniqueTables.upsert(doc);
      tableCache.set(stored.id, stored);
      return stored;
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

  // Point the settings view at the resolved workspace before anything reads a
  // setting (the plugin host below does, immediately).
  activeWorkspaceId = workspaceId;

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
      api.ui.dialogs.toast(`Imported ${rowCount} row${rowCount === 1 ? '' : 's'} into "${t?.name ?? tableId}".`, { kind: 'success', title: source.toUpperCase() + ' import' });
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
          'session only — nothing was changed. Disable the culprit below, then reload ' +
          'without ?safemode.',
        { kind: 'warning', title: 'Safe mode' },
      );
    } else if (SAFE_MODE === 'url-plugins') {
      api.ui.dialogs.toast('Safe mode (URL plugins) is ON: URL-installed plugins were not loaded this ' + 'session. Built-in plugins are unaffected. Reload without ?safemode1 to restore them.', {
        kind: 'warning',
        title: 'Safe mode',
      });
    }

    // Safe mode exists to reach the Plugin Manager when a plugin breaks the
    // app, so open it for the user instead of making them find the button in a
    // half-loaded shell. Both levels get it — the dialog marks the plugins each
    // level skipped and is where the user turns the culprit off for good.
    if (SAFE_MODE !== 'off') api.ui.openPluginManager();
  });

  // User scripting: the very HostApi that plugins receive, on `window.api`, so
  // anything a plugin can do can also be typed into the browser console —
  // `api.store.tables.find()`, `api.ui.dialogs.toast('hi')`. Not gated by
  // `?test=1` (that gate is for `window.__easydb`, the whole AppContext).
  (globalThis as unknown as Record<string, unknown>).api = api;

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

/**
 * Drop the remembered workspace if it is `id`. Called when a workspace is
 * deleted: otherwise the next reload without `?space=` resolves step 2 to a
 * workspace that no longer exists, and lands on whichever one happens to be
 * first instead of the one the user was sent to.
 */
export function forgetLastWorkspace(id: string): void {
  try {
    if (globalThis.localStorage?.getItem(LAST_WORKSPACE_KEY) === id) {
      globalThis.localStorage.removeItem(LAST_WORKSPACE_KEY);
    }
  } catch {
    /* ignore — persistence is best-effort */
  }
}

function persistLastWorkspace(id: string): void {
  try {
    globalThis.localStorage?.setItem(LAST_WORKSPACE_KEY, id);
  } catch {
    /* ignore — persistence is best-effort */
  }
}

/** Workspace name → id. Only `a-z0-9_-` survive, so an id never contains the
 *  `::` that separates a setting's workspace from its name (see `settingId`). */
export function slugifyWorkspace(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default'
  );
}
