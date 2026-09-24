import { test, expect } from './fixtures.js';

/**
 * api.backend.fetch is always a direct browser fetch — there is no proxy to
 * route through. This covers that direct-fetch path.
 */

test.describe('backend.fetch', () => {
  test('is a direct fetch', async ({ page }) => {
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
