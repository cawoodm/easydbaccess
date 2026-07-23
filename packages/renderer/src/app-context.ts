import type { DataStore, EventBus, HostApi, RowSourceCtx, Table } from '@easydb/shared';
import { createDataStore, createRoutedDataStore, getDb } from './db/index.js';
import { createEventBus } from './events/bus.js';
import { createRegistries, type Registries } from './plugin-host/registries.js';
import { createHostApi } from './plugin-host/api-factory.js';
import { loadBuiltinPlugins } from './plugin-host/loader.js';
import { loadUrlPlugins } from './plugin-host/url-loader.js';

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
    base: baseStore,
    providers: registries.rowSources,
    tableById: (id) => tableCache.get(id),
    ctx: rowSourceCtx,
  });

  // Workspace resolution priority:
  //   1. ?space=NAME URL param — if a matching workspace exists, use it.
  //                              If not, create one with that id+name.
  //   2. Otherwise, the first workspace in the store.
  //   3. Otherwise, create a "default" workspace.
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
  } else if (existing.length === 0) {
    const ws = await store.workspaces.insert({
      id: 'default',
      name: 'default',
      createdAt: Date.now(),
      pluginUrls: [],
    });
    workspaceId = ws.id;
  } else {
    workspaceId = existing[0]!.id;
  }

  const api = createHostApi({
    store,
    events,
    registries,
    workspaceId: () => workspaceId,
  });
  apiRef = api;

  // Centralized import-status toasts so every importer (csv, json, gist pull,
  // future ones) gets consistent UX without duplicating the toast call.
  events.on('import:after', ({ source, tableId, rowCount }) => {
    void api.store.tables.findOne(tableId).then((t) => {
      api.ui.dialogs.toast(
        `Imported ${rowCount} row${rowCount === 1 ? '' : 's'} into "${t?.name ?? tableId}".`,
        { kind: 'success', title: source.toUpperCase() + ' import' },
      );
    });
  });
  events.on('plugin:error', ({ url, phase, error }) => {
    api.ui.dialogs.toast(
      `[${phase}] ${(error as Error)?.message ?? String(error)}`,
      { kind: 'error', title: `Plugin: ${url}` },
    );
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
  });

  return { store, events, workspaceId, registries, api };
}

function readWorkspaceFromUrl(): string | null {
  if (typeof location === 'undefined') return null;
  const sp = new URLSearchParams(location.search);
  const v = sp.get('space');
  return v && v.trim().length > 0 ? v.trim() : null;
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
