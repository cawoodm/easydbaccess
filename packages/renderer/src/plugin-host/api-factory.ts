import type {
  DataStore,
  EventBus,
  HostApi,
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
    backend: {
      // Phase-6 backend wiring will route through the Hono /fetch endpoint
      // (or directly via IPC in Electron). For now, pass through.
      fetch: (url, init) => fetch(url, init as RequestInit | undefined),
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
