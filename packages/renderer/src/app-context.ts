import type { DataStore, EventBus, HostApi } from '@easydb/shared';
import { createDataStore, getDb } from './db/index.js';
import { createEventBus } from './events/bus.js';
import { createRegistries, type Registries } from './plugin-host/registries.js';
import { createHostApi } from './plugin-host/api-factory.js';
import { loadBuiltinPlugins } from './plugin-host/loader.js';

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
  const store = createDataStore(db);
  const events = createEventBus();
  const registries = createRegistries();

  // Ensure a default workspace exists.
  const existing = await store.workspaces.find();
  let workspaceId: string;
  if (existing.length === 0) {
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

  // init() built-ins synchronously, then trigger load() after we emit app:ready.
  const runLoad = await loadBuiltinPlugins(api);

  queueMicrotask(async () => {
    events.emit('app:ready', { workspaceId });
    await runLoad();
  });

  return { store, events, workspaceId, registries, api };
}
