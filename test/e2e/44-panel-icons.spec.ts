import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Each window kind (window-mgr/table-kind.ts) gets its own SVG icon at the
 * far left of the jsPanel titlebar (jsPanel's `headerLogo` slot), and
 * refreshable tables (source- or origin-backed) get a distinct panel colour
 * via the `eda-refreshable` class (index.html).
 *
 * The second test patches `source` onto an already-open plain table with a
 * source.type NOT registered by any built-in plugin (only 'url' and
 * 'datasette' are). `routed-data-store.ts` treats an unregistered type as a
 * strict no-op — `rows()` falls back to the local Dexie collection — so this
 * exercises the runtime kind-change path (icon + colour update without
 * reopening the window) with no network mocking required.
 */
test.describe('panel titlebar kind icons', () => {
  test('a plain local table shows the normal icon and no refreshable class', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);

    const icon = page.locator(`#${panelDomId(id)} .jsPanel-headerlogo svg`);
    await expect(icon).toHaveAttribute('aria-label', 'Local table');
    await expect(page.locator(`#${panelDomId(id)}`)).not.toHaveClass(/eda-refreshable/);
  });

  test('a table with a source shows the connected icon and the refreshable class', async ({
    page,
  }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);

    // Starts as a plain local table (normal icon, no refreshable class).
    const icon = page.locator(`#${panelDomId(id)} .jsPanel-headerlogo svg`);
    await expect(icon).toHaveAttribute('aria-label', 'Local table');
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel).not.toHaveClass(/eda-refreshable/);

    // Gains a `source` at runtime (e.g. a live connect) — the SAME window
    // must update its logo + colour without reopening.
    await page.evaluate(async (tableId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.tables.patch(tableId, {
        source: { type: 'unregistered-test-backend', config: {} },
        updatedAt: Date.now(),
      });
    }, id);

    await expect(icon).toHaveAttribute('aria-label', 'Connected table (live)');
    await expect(panel).toHaveClass(/eda-refreshable/);
  });
});
