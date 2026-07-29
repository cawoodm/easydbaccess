import { test, expect } from './fixtures.js';
import { SERVER_URL } from './server-url.js';

/**
 * GET /plugins/registry returns the file at PLUGINS_REGISTRY_PATH (set in
 * playwright.config.ts webServer env). The Plugin Manager dialog merges
 * those entries into its single unified, filterable/searchable plugin list
 * when `server-sync:url` is configured for the current workspace — there is
 * no separate "From server" section any more (see plugin-manager-dialog.ts).
 */

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

  test('Plugin Manager dialog shows the server-registry plugin in the unified list when configured', async ({
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

    // The search box, the three category toggles, and the status toggle all
    // share the row above the unified list.
    await expect(dialog.getByPlaceholder('Search plugins…')).toBeVisible();
    const filters = dialog.locator('.filters .tri');
    await expect(filters).toHaveCount(4);
    await expect(filters).toContainText(['Installed', 'Built-in', 'Fixed', 'Enabled']);
    // Tri-state: clicking a filter cycles off → on → not (adds a state class).
    const installed = filters.filter({ hasText: 'Installed' });
    await installed.click();
    await expect(installed).toHaveClass(/\bon\b/);
    await installed.click();
    await expect(installed).toHaveClass(/\bnot\b/);
    await installed.click();
    await expect(installed).not.toHaveClass(/\b(on|not)\b/);

    // A separate "by type" filter row carries one tri-state chip per PluginType.
    const typeFilters = dialog.locator('.type-filters .tri');
    await expect(typeFilters).toHaveCount(6);
    await expect(typeFilters).toContainText([
      'Importer',
      'Exporter',
      'Cell renderer',
      'Sync',
      'Source',
      'UI',
    ]);
    const importer = typeFilters.filter({ hasText: 'Importer' });
    await importer.click();
    await expect(importer).toHaveClass(/\bon\b/);
    await importer.click();
    await expect(importer).toHaveClass(/\bnot\b/);
    await importer.click();
    await expect(importer).not.toHaveClass(/\b(on|not)\b/);

    // The server-registry entry shows up as a row in the same list — no
    // separate "From server" section header exists any more.
    await expect(dialog.getByText('Server Demo')).toBeVisible();
  });

  test('Server-registry plugin is absent from the list when no URL is configured', async ({
    page,
  }) => {
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

    await expect(dialog.getByText('Server Demo')).toHaveCount(0);
  });
});
