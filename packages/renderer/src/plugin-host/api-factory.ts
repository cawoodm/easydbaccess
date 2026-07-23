import type {
  DataStore,
  EventBus,
  HostApi,
  RowCollectionProvider,
  Unregister,
  WindowHandle,
  WindowManager,
  WindowSpec,
} from '@easydb/shared';
import { createUiRegistry, type Registries } from './registries.js';

export interface ApiFactoryOpts {
  store: DataStore;
  events: EventBus;
  registries: Registries;
  workspaceId: () => string | null;
  selfUrl?: string;
}

/**
 * Builds the HostApi handed to each plugin's init/load. The same object is
 * reused across all plugins — plugins MAY monkey-patch its methods.
 */
export function createHostApi(opts: ApiFactoryOpts): HostApi {
  const ui = createUiRegistry(opts.registries);

  const rowSources = opts.registries.rowSources;
  const registerRowSource = (provider: RowCollectionProvider): Unregister => {
    rowSources.set(provider.type, provider);
    return () => {
      if (rowSources.get(provider.type) === provider) rowSources.delete(provider.type);
    };
  };

  const windows: WindowManager = {
    open(spec: WindowSpec): WindowHandle {
      // Phase 5 will replace this with a real <app-window> custom element.
      // eslint-disable-next-line no-console
      console.warn('[host] windows.open is stubbed until Phase 5', spec.id);
      return {
        id: spec.id,
        close: () => undefined,
        focus: () => undefined,
        setTitle: () => undefined,
        setGeometry: () => undefined,
      };
    },
    list: () => [],
    find: () => null,
  };

  return {
    store: opts.store,
    events: opts.events,
    ui,
    windows,
    registerRowSource,
    backend: {
      /**
       * Routes through the Hono `/fetch` proxy when the user has configured
       * a server URL (the same `server-sync:url` setting `server-sync` and
       * `auto-sync` use). Falls back to direct browser fetch when no URL is
       * set, so offline workspaces work unchanged.
       *
       * The proxy lets plugins reach CORS-blocked APIs and enforces the
       * server's allowlist + byte cap. ArrayBuffer bodies bypass the proxy
       * — the server route only accepts string bodies, so forwarding binary
       * payloads would need a separate base64 path.
       */
      fetch: async (url, init) => {
        const base = await readServerBaseUrl(opts.store);
        const bodyIsArrayBuffer = init?.body instanceof ArrayBuffer;
        if (!base || bodyIsArrayBuffer) {
          return globalThis.fetch(url, init as RequestInit | undefined);
        }
        const payload: Record<string, unknown> = { url };
        if (init?.method) payload.method = init.method;
        if (init?.headers) payload.headers = init.headers;
        if (typeof init?.body === 'string') payload.body = init.body;
        return globalThis.fetch(`${base}/fetch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      },
      async saveFile(filename, body, mimeType) {
        const blob =
          typeof body === 'string'
            ? new Blob([body], { type: mimeType ?? 'application/octet-stream' })
            : body;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    },
    workspaceId: () => opts.workspaceId(),
    selfUrl: () => opts.selfUrl ?? '(builtin)',
  };
}

/**
 * Reads `server-sync:url` from the settings collection — same key that
 * server-sync and auto-sync write. Inlined here so api-factory doesn't have
 * to import from `plugins/`, which would invert the dependency direction.
 */
async function readServerBaseUrl(store: DataStore): Promise<string | null> {
  const s = await store.settings.findOne('server-sync:url');
  const v = s?.value;
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.replace(/\/+$/, '');
}
