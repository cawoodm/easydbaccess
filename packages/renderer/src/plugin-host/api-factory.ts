import type { DataStore, EventBus, HostApi, RowCollectionProvider, SettingScope, SettingsApi, Unregister, WindowHandle, WindowManager, WindowSpec } from '@easydb/shared';
import { createUiRegistry, type Registries } from './registries.js';
import { hasUserSetting, interpolateSecrets, parseSecrets, readSecretsText, readUserSetting, removeUserSetting, writeUserSetting } from '../db/user-settings.js';
import { resolvesToSameSecret } from '../db/secret-guard.js';

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

  const settings = createSettingsApi(opts.store, opts.registries);

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
    settings,
    backend: {
      /**
       * Always a direct browser fetch. There used to be a proxy fallback
       * here that routed through the (now-removed) Hono `/fetch` route
       * when a `server-sync:url` setting was present. That fallback keyed
       * on the SETTING being present, not on the server being reachable,
       * so a workspace with a stale `server-sync:url` sent every plugin
       * fetch to a dead host. A direct fetch has no such hazard, at the
       * cost of depending on the target site's CORS headers.
       */
      fetch: async (url, init) => globalThis.fetch(url, init as RequestInit | undefined),
      async saveFile(filename, body, mimeType) {
        const blob = typeof body === 'string' ? new Blob([body], { type: mimeType ?? 'application/octet-stream' }) : body;
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
 * The layer-aware settings resolver. Read precedence: user layer, then the
 * workspace `settings` table, then the registered field default. Writes go to
 * a single layer and remove the other so a key never lives in both — matching
 * the dialog's promote/demote toggle. String values interpolate secrets on read.
 */
function createSettingsApi(store: DataStore, registries: Registries): SettingsApi {
  const fullKey = (pluginId: string, key: string) => `${pluginId}:${key}`;

  const fieldOf = (pluginId: string, key: string) => registries.settings.get(pluginId)?.fields.find((f) => f.key === key);

  const resolveSecrets = (value: unknown): unknown => (typeof value === 'string' ? interpolateSecrets(value, parseSecrets(readSecretsText())) : value);

  /** The RAW stored value of a key — the reference text, not what it resolves to. */
  const rawOf = async (k: string): Promise<unknown> => (hasUserSetting(k) ? readUserSetting(k) : (await store.settings.findOne(k))?.value);

  /**
   * Would this write replace a stored `${secret:name}` reference with the secret
   * it resolves to? The rule and the reasoning are in `db/secret-guard.ts`;
   * gist-sync saving a new gist id alongside the credentials it had just read is
   * how it was found.
   */
  const isResolvedRefWrite = async (k: string, next: unknown): Promise<boolean> => resolvesToSameSecret(await rawOf(k), next, parseSecrets(readSecretsText()));

  return {
    async get<T = unknown>(pluginId: string, key: string): Promise<T | undefined> {
      const k = fullKey(pluginId, key);
      let value: unknown;
      if (hasUserSetting(k)) {
        value = readUserSetting(k);
      } else {
        const ws = await store.settings.findOne(k);
        value = ws ? ws.value : fieldOf(pluginId, key)?.default;
      }
      return resolveSecrets(value) as T | undefined;
    },

    async set(pluginId, key, value, scope): Promise<void> {
      const k = fullKey(pluginId, key);
      // Keep a `${secret:name}` reference rather than let its own resolved value
      // overwrite it — see `isResolvedRefWrite`.
      if (await isResolvedRefWrite(k, value)) return;
      const target: SettingScope = scope ?? fieldOf(pluginId, key)?.scope ?? 'workspace';
      if (target === 'user') {
        writeUserSetting(k, value);
        await store.settings.remove(k).catch(() => undefined);
      } else {
        await store.settings.upsert({ name: k, value });
        removeUserSetting(k);
      }
    },

    async placement(pluginId, key): Promise<SettingScope | null> {
      const k = fullKey(pluginId, key);
      if (hasUserSetting(k)) return 'user';
      return (await store.settings.findOne(k)) ? 'workspace' : null;
    },
  };
}
