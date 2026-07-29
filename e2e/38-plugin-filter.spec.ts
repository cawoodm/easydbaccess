import { test, expect } from './fixtures.js';

/**
 * The Plugin Manager dialog's unified list carries tri-state filter chips for
 * category + status (one row) and plugin type (a second row). Status is a
 * SINGLE chip: off = any, on = enabled only, not = disabled only.
 *
 * Semantic trap: `PluginRow.enabled` is `true` for any row without a
 * `PluginRecord` (i.e. a catalog entry that's listed but never installed) —
 * that's a display default, not a real status. The status filter must only
 * apply to rows that can actually be toggled (built-in or installed); a
 * merely-"available" catalog row must appear under neither state of the chip.
 */

test.describe('plugin manager status filter', () => {
  test('with no status filter active, the row list is unchanged', async ({ page }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });
    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();
    // Header Clock is a catalog-only demo plugin — never installed by
    // default — so its presence confirms the catalog fetch has landed
    // before we snapshot the row count.
    await expect(dialog.getByText('Header Clock')).toBeVisible();

    const rows = dialog.locator('.plugin-list .row');
    const total = await rows.count();
    expect(total).toBeGreaterThan(0);

    // One chip, not two — "Disabled" is the same chip's third state.
    const enabledChip = dialog.locator('.filters .tri.status');
    await expect(enabledChip).toHaveCount(1);
    await expect(enabledChip).toContainText('Enabled');

    // Cycling the chip fully off -> on -> not -> off must restore the
    // original, unfiltered row count.
    await enabledChip.click();
    await enabledChip.click();
    await enabledChip.click();
    await expect(enabledChip).not.toHaveClass(/\b(on|not)\b/);
    await expect(rows).toHaveCount(total);
  });

  test('the status chip cycles enabled-only → disabled-only → any', async ({ page }) => {
    // Disable a real, non-fixed built-in so there is a genuine disabled row
    // to filter on.
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.plugins.upsert({
        url: 'builtin:gist-sync',
        enabled: false,
        lastFetched: 0,
      });
    });

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });
    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Gist Sync')).toBeVisible();
    await expect(dialog.getByText('CSV Import')).toBeVisible();

    const statusChip = dialog.locator('.filters .tri.status');

    // First click -> only enabled rows show.
    await statusChip.click();
    await expect(statusChip).toHaveClass(/\bon\b/);
    await expect(dialog.getByText('Gist Sync')).toHaveCount(0);
    await expect(dialog.getByText('CSV Import')).toBeVisible();

    // Second click ("not") -> only DISABLED rows show. Enabled and disabled are
    // the only two statuses, so hiding one is the same as showing the other.
    await statusChip.click();
    await expect(statusChip).toHaveClass(/\bnot\b/);
    await expect(dialog.getByText('Gist Sync')).toBeVisible();
    await expect(dialog.getByText('CSV Import')).toHaveCount(0);

    // Third click -> off, both are back.
    await statusChip.click();
    await expect(statusChip).not.toHaveClass(/\b(on|not)\b/);
    await expect(dialog.getByText('Gist Sync')).toBeVisible();
    await expect(dialog.getByText('CSV Import')).toBeVisible();
  });

  test('"Enabled" includes the always-on fixed built-ins', async ({ page }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });
    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();

    // Fixed built-ins are listed like any other plugin — they used to be hidden
    // unless the "Fixed" chip was on, which made "Enabled" hide the only two
    // plugins that can never be disabled. They show a lock instead of a toggle.
    const settings = dialog.locator('.row', { hasText: 'Settings' });
    const coreRenderers = dialog.locator('.row', { hasText: 'Core Renderers' });
    await expect(settings.locator('.lock-icon')).toBeVisible();
    await expect(coreRenderers.locator('.lock-icon')).toBeVisible();

    await dialog.locator('.filters .tri.status').click();
    await expect(settings).toBeVisible();
    await expect(coreRenderers).toBeVisible();
  });

  test('a listed-but-not-installed catalog plugin has no status at all', async ({ page }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });
    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();
    // Present in the unfiltered list first (catalog fetch landed).
    await expect(dialog.getByText('Header Clock')).toBeVisible();

    const statusChip = dialog.locator('.filters .tri.status');

    // Header Clock is catalog-only and never installed in this test. It has no
    // status, so it must not masquerade as enabled...
    await statusChip.click();
    await expect(statusChip).toHaveClass(/\bon\b/);
    await expect(dialog.getByText('Header Clock')).toHaveCount(0);

    // ...nor turn up as disabled.
    await statusChip.click();
    await expect(statusChip).toHaveClass(/\bnot\b/);
    await expect(dialog.getByText('Header Clock')).toHaveCount(0);
  });
});
