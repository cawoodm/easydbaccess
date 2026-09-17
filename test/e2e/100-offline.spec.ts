import { test, expect } from './fixtures.js';

/**
 * The app with no internet.
 *
 * Scope note, so nobody chases the missing half: this suite runs against the
 * **Vite dev server**, which deliberately has no service worker (`apply: 'build'`
 * in `vite.config.ts`, plus `import.meta.env.PROD` in `pwa/register-sw.ts`).
 * Cutting the network there stops the page loading at all, so an offline
 * *reload* cannot be tested here — that is a property of the built, served app
 * and is covered by `test/renderer/pwa/generate-sw.test.ts` plus the manual
 * checklist in `docs/tech/OFFLINE.md`.
 *
 * What IS tested here is the half that decides whether an offline user gets
 * their workspace or an empty shell:
 *
 *  - Boot must finish. A URL plugin whose host accepts the connection and then
 *    says nothing used to leave `getContext()` pending forever, and every chrome
 *    component awaits it.
 *  - Boot must be quiet. Offline, every uncached plugin fails at once; one error
 *    toast each says nothing the user does not already know.
 *  - The data layer must not care. SQLite lives in OPFS; nothing about reading
 *    or writing a row touches the network.
 */

test('losing the connection shows the chip and does not stop the data layer', async ({ page, workspaceId, context }) => {
  await context.setOffline(true);
  try {
    // The chip is fed by the browser's own `offline` event — see `util/net.ts`.
    await expect(page.locator('app-shell header .offline-chip')).toBeVisible();

    const wrote = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      const t = await api.store.tables.insert({ id: `offline-${ws}`, name: 'offline', columns: [{ field: 'a', label: 'A', type: 'string' }] });
      await api.store.rows(t.id).insert({ id: 'r1', tableId: t.id, data: { a: 'no network needed' } });
      const rows = await api.store.rows(t.id).find();
      return { count: rows.length, value: rows[0]?.data?.a };
    }, workspaceId);

    expect(wrote).toEqual({ count: 1, value: 'no network needed' });
  } finally {
    await context.setOffline(false);
  }

  await expect(page.locator('app-shell header .offline-chip')).toHaveCount(0);
});

test('a plugin URL that never answers does not hold up boot', async ({ page, workspaceId }) => {
  // Install a URL plugin with no cached body, so the next boot has to fetch it.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.store.workspaces.patch(ctx.workspaceId, { pluginUrls: ['https://black.hole.invalid/plugin.js'] });
  });

  // A host that accepts the connection and then says nothing — the shape that
  // used to hang forever, and the one `navigator.onLine` cannot detect.
  await page.route('https://black.hole.invalid/**', () => {
    /* never fulfilled, never aborted */
  });

  const started = Date.now();
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 25_000 });
  const elapsed = Date.now() - started;

  await expect(page.locator('app-shell header')).toBeVisible();
  // The loader's boot budget is 10s; anything near the 25s wait above means the
  // budget is gone and the hang is back.
  expect(elapsed).toBeLessThan(20_000);
});

test('an offline boot does not toast about every plugin it could not fetch', async ({ page, workspaceId }) => {
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.store.workspaces.patch(ctx.workspaceId, {
      pluginUrls: ['https://a.invalid/one.js', 'https://b.invalid/two.js'],
    });
  });

  // Offline is simulated per-request rather than with `context.setOffline`,
  // because the dev server has no service worker and a truly offline page could
  // not load its own bundle. The app sees exactly what it would offline: a
  // `navigator.onLine` of false and a transport failure on every remote URL.
  await page.addInitScript(() => Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }));
  await page.route('https://*.invalid/**', (route) => route.abort('internetdisconnected'));

  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  // Give the boot sequence room to have toasted if it were going to.
  await page.waitForTimeout(2_000);
  await expect(page.locator('app-shell toast-host').getByText(/Plugin:/)).toHaveCount(0);

  // The reason still has to be recorded — the Plugin Manager is where the user
  // goes to ask why a plugin is missing.
  const errors = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const recs = await (window as any).__easydb.store.plugins.find();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return recs.filter((r: any) => String(r.url).endsWith('.js')).map((r: any) => String(r.lastError ?? ''));
  });
  expect(errors.length).toBeGreaterThan(0);
  for (const e of errors) expect(e).toMatch(/fetch:/);
});
