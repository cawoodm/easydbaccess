import { test, expect } from './fixtures.js';

/**
 * GET /plugins/registry returns the file at PLUGINS_REGISTRY_PATH (set in
 * playwright.config.ts webServer env). The Plugin Manager dialog surfaces
 * those entries in a "From server" section when `server-sync:url` is
 * configured for the current workspace.
 */

const SERVER_URL = 'http://localhost:3998';

test.describe('plugins registry', () => {
  test('GET /plugins/registry serves the configured file', async () => {
    const res = await fetch(`${SERVER_URL}/plugins/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plugins: Array<{ id: string; name: string }> };
    expect(body.plugins).toHaveLength(1);
    expect(body.plugins[0]).toMatchObject({
      id: 'demo-from-server',
      name: 'Server Demo',
    });
  });

  test('Plugin Manager dialog shows the "From server" section when configured', async ({
    page,
  }) => {
    await page.evaluate(async (url) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.settings.upsert({ key: 'server-sync:url', value: url });
    }, SERVER_URL);

    // Open the Plugin Manager via the registered header button.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });

    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();

    // Both section headers exist: the host catalog and the server registry.
    await expect(dialog.getByText('From server', { exact: true })).toBeVisible();
    await expect(dialog.getByText('Server Demo')).toBeVisible();
  });

  test('"From server" section is absent when no URL is configured', async ({ page }) => {
    // Fresh workspace fixture — no server-sync:url has been set.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });

    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();
    // Wait a beat to give refreshServerRegistry a chance to run; it should
    // see no URL and bail.
    await page.waitForTimeout(200);

    await expect(dialog.getByText('From server', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('Server Demo')).toHaveCount(0);
  });
});
