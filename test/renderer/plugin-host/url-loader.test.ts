import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostApi, PluginRecord, Workspace } from '@easydb/shared';
import { loadUrlPlugins } from '../../../packages/renderer/src/plugin-host/url-loader.js';

/**
 * Booting with no internet.
 *
 * `app-context.ts` awaits this loader before `getContext()` resolves, and every
 * chrome component awaits `getContext()`. So this module decides whether an
 * offline user gets their workspace or an empty shell.
 *
 * Two rules, both regression-shaped:
 *
 *  1. It must always finish. A plugin URL that accepts the connection and then
 *     says nothing used to leave the app hanging forever — no tables, no error,
 *     no way out. One shared budget bounds the whole uncached phase.
 *  2. It must be quiet about the network. Offline, EVERY uncached plugin fails
 *     at once; one error toast each tells the user nothing they do not already
 *     know. A 404 or broken JS is a different thing and must still speak up.
 */

interface Harness {
  api: HostApi;
  errors: Array<{ url: string; phase: string }>;
  records: Map<string, PluginRecord>;
}

function harness(pluginUrls: string[], cached: Record<string, string> = {}): Harness {
  const errors: Harness['errors'] = [];
  const records = new Map<string, PluginRecord>();
  for (const [url, cachedBody] of Object.entries(cached)) {
    records.set(url, { url, enabled: true, lastFetched: 0, cachedBody } as PluginRecord);
  }

  const api = {
    workspaceId: () => 'ws',
    events: {
      emit: (name: string, detail: { url: string; phase: string }) => {
        if (name === 'plugin:error') errors.push({ url: detail.url, phase: detail.phase });
      },
    },
    store: {
      workspaces: {
        findOne: async () => ({ id: 'ws', name: 'ws', createdAt: 0, pluginUrls }) as Workspace,
      },
      plugins: {
        findOne: async (url: string) => records.get(url) ?? null,
        upsert: async (rec: PluginRecord) => {
          records.set(rec.url, { ...records.get(rec.url), ...rec });
          return rec;
        },
      },
    },
  } as unknown as HostApi;

  return { api, errors, records };
}

/** A host that connects and then never answers — a captive portal, a black hole. */
function stubHangingFetch(): void {
  vi.stubGlobal('fetch', (_input: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
});

describe('loadUrlPlugins with no network', () => {
  it('finishes even when every plugin URL hangs', async () => {
    stubHangingFetch();
    const { api } = harness(['https://a.invalid/p.js', 'https://b.invalid/p.js']);

    // The boot budget is 10s in the product; this asserts the loader settles
    // well inside it rather than never. Without the budget this call never
    // resolves and the test times out — which is exactly the bug.
    const started = Date.now();
    await expect(loadUrlPlugins(api)).resolves.toBeTypeOf('function');
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 30_000);

  it('does not toast a network failure — it records it instead', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    stubHangingFetch();
    const { api, errors, records } = harness(['https://a.invalid/p.js', 'https://b.invalid/p.js']);

    await loadUrlPlugins(api);

    expect(errors).toEqual([]);
    // The Plugin Manager is where you go to ask why a plugin is missing, so the
    // reason has to survive somewhere — just not as two toasts at boot.
    expect(records.get('https://a.invalid/p.js')?.lastError).toMatch(/fetch:/);
    expect(records.get('https://b.invalid/p.js')?.lastError).toMatch(/fetch:/);
  });

  it('still reports a plugin that is genuinely broken', async () => {
    // A 404 answered by a static host's SPA fallback: reachable, and wrong.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<!doctype html><html></html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    const { api, errors } = harness(['https://a.test/gone.js']);

    await loadUrlPlugins(api);

    expect(errors).toEqual([{ url: 'https://a.test/gone.js', phase: 'fetch' }]);
  });

  it('makes no request at all for a plugin it has cached', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    const fetchSpy = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    vi.stubGlobal('fetch', fetchSpy);
    const { api, errors } = harness(['https://a.test/p.js'], { 'https://a.test/p.js': 'export {};' });

    await loadUrlPlugins(api);

    // This is what makes an ordinary offline boot work: the cached body is
    // taken as-is, and the background refresh stands down rather than firing a
    // request that cannot succeed.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(errors.filter((e) => e.phase === 'fetch')).toEqual([]);
  });
});
