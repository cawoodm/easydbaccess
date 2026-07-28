import { test, expect } from './fixtures.js';

/**
 * The Plugin Manager dialog's unified list already carries two tri-state
 * filter rows (category, type). This adds a third: enabled/disabled status.
 *
 * Semantic trap: `PluginRow.enabled` is `true` for any row without a
 * `PluginRecord` (i.e. a catalog entry that's listed but never installed) —
 * that's a display default, not a real status. The status filter must only
 * apply to rows that can actually be toggled (built-in or installed); a
 * merely-"available" catalog row must never appear under "Enabled".
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

    const statusFilters = dialog.locator('.status-filters .tri');
    await expect(statusFilters).toHaveCount(2);
    await expect(statusFilters).toContainText(['Enabled', 'Disabled']);

    // Cycling a chip fully off -> on -> not -> off must restore the
    // original, unfiltered row count.
    const enabledChip = statusFilters.filter({ hasText: 'Enabled' });
    await enabledChip.click();
    await enabledChip.click();
    await enabledChip.click();
    await expect(enabledChip).not.toHaveClass(/\b(on|not)\b/);
    await expect(rows).toHaveCount(total);
  });

  test('Enabled/Disabled isolate rows by status; the third click ("not") hides matches', async ({
    page,
  }) => {
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

    const statusFilters = dialog.locator('.status-filters .tri');
    const enabledChip = statusFilters.filter({ hasText: 'Enabled' });
    const disabledChip = statusFilters.filter({ hasText: 'Disabled' });

    // "Enabled" on -> only enabled rows show.
    await enabledChip.click();
    await expect(enabledChip).toHaveClass(/\bon\b/);
    await expect(dialog.getByText('Gist Sync')).toHaveCount(0);
    await expect(dialog.getByText('CSV Import')).toBeVisible();

    // Cycle back to off before touching the other chip.
    await enabledChip.click(); // -> not
    await enabledChip.click(); // -> off
    await expect(enabledChip).not.toHaveClass(/\b(on|not)\b/);

    // "Disabled" on -> only disabled rows show.
    await disabledChip.click();
    await expect(disabledChip).toHaveClass(/\bon\b/);
    await expect(dialog.getByText('Gist Sync')).toBeVisible();
    await expect(dialog.getByText('CSV Import')).toHaveCount(0);

    // Third click -> "not" hides the matching (disabled) rows instead.
    await disabledChip.click();
    await expect(disabledChip).toHaveClass(/\bnot\b/);
    await expect(dialog.getByText('Gist Sync')).toHaveCount(0);
    await expect(dialog.getByText('CSV Import')).toBeVisible();
  });

  test('a listed-but-not-installed catalog plugin never appears under "Enabled"', async ({
    page,
  }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydb.api.ui.openPluginManager();
    });
    const dialog = page.locator('plugin-manager-dialog dialog');
    await expect(dialog).toBeVisible();
    // Present in the unfiltered list first (catalog fetch landed).
    await expect(dialog.getByText('Header Clock')).toBeVisible();

    const statusFilters = dialog.locator('.status-filters .tri');
    const enabledChip = statusFilters.filter({ hasText: 'Enabled' });
    await enabledChip.click();
    await expect(enabledChip).toHaveClass(/\bon\b/);

    // Header Clock is catalog-only and never installed in this test — it
    // has no status and must not masquerade as "Enabled".
    await expect(dialog.getByText('Header Clock')).toHaveCount(0);
  });
});
