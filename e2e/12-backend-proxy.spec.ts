import { test, expect } from './fixtures.js';
import { SERVER_URL } from './server-url.js';

/**
 * api.backend.fetch should route through the configured server's /fetch
 * endpoint when `server-sync:url` is set, and fall back to direct browser
 * fetch when it isn't.
 *
 * The Hono backend runs on this branch's server port (see
 * playwright.config.ts webServer + server-url.ts). We call /fetch through the
 * proxy and inspect which URL was actually fetched by wrapping window.fetch
 * from inside the page.
 */

test.describe('backend.fetch proxy', () => {
  test('routes through /fetch when server-sync:url is configured', async ({ page }) => {
    await page.evaluate(async (url) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.settings.upsert({ key: 'server-sync:url', value: url });
    }, SERVER_URL);

    // The server's allowlist is unset → it'll happily proxy any host. We
    // pick the server's own /health endpoint as the target so the proxy
    // round-trip actually returns content (vs. an unreachable example.com).
    const probe = await page.evaluate(async () => {
      const calls: string[] = [];
      const orig = window.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.fetch = ((...args: any[]) => {
        calls.push(String(args[0]));
        return orig.apply(window, args as Parameters<typeof window.fetch>);
      }) as typeof window.fetch;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const res = await ctx.api.backend.fetch('http://example.com/anything');
        return { calls, status: res.status };
      } finally {
        window.fetch = orig;
      }
    });

    // The very first network call from backend.fetch should be the proxy
    // endpoint, not example.com.
    expect(probe.calls[0]).toBe(`${SERVER_URL}/fetch`);
    expect(probe.calls.some((u) => u.includes('example.com'))).toBe(false);
  });

  test('falls back to direct fetch when server-sync:url is unset', async ({ page }) => {
    // Default state: no server URL set in this workspace.
    const probe = await page.evaluate(async () => {
      const calls: string[] = [];
      const orig = window.fetch;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.fetch = ((...args: any[]) => {
        calls.push(String(args[0]));
        // Short-circuit the actual network call — we only care which URL
        // was attempted. example.com from Chromium-in-Playwright would
        // otherwise time out.
        return Promise.resolve(new Response('ok', { status: 200 }));
      }) as typeof window.fetch;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        await ctx.api.backend.fetch('http://example.com/anything');
        return calls;
      } finally {
        window.fetch = orig;
      }
    });

    expect(probe).toEqual(['http://example.com/anything']);
  });
});
