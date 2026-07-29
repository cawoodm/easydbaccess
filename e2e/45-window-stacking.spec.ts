import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * Table windows (`jspanel-manager.ts`) and view windows (`view-window-manager.ts`)
 * are two independent managers, each with its own liveQuery subscription. A
 * saved z only reproduced the order WITHIN one manager's own boot loop — the
 * relative order BETWEEN a table and a view was decided by whichever manager
 * happened to create its panel last (tables always open before views — see
 * `table-list.ts`), not by which one was actually fronted last. See
 * `window-mgr/z-order.ts` + `window-mgr/restack.ts` for the merged-order fix.
 */
test.describe('window stacking across tables and views', () => {
  /** Creates an RSS-templated view over `tableId` via the real dialog flow
   * (mirrors `e2e/23-views.spec.ts`). Returns the view's jsPanel DOM id. */
  async function createViewOver(page: Page, tableId: string): Promise<string> {
    await page
      .locator(`#${panelDomId(tableId)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    await expect(page.locator('view-window')).toBeVisible();
    return page.evaluate(() => document.querySelector('view-window')!.closest('.jsPanel')!.id);
  }

  async function zIndexOf(page: Page, domId: string): Promise<number> {
    return page.evaluate(
      (id) => Number(getComputedStyle(document.getElementById(id)!).zIndex) || 0,
      domId,
    );
  }

  async function front(page: Page, domId: string): Promise<void> {
    await page.evaluate((id) => {
      const el = document.getElementById(id) as HTMLElement & { front?: () => void };
      el?.front?.();
    }, domId);
  }

  async function makeTableAndView(
    page: Page,
  ): Promise<{ tablePanelId: string; viewPanelId: string; tableId: string }> {
    const tableId = await createTable(page, 'Feed', [
      { field: 'title' },
      { field: 'url' },
      { field: 'date' },
      { field: 'description' },
    ]);
    await waitForPanel(page, tableId);
    await bulkAddRows(page, tableId, [
      { title: 'Hello', url: 'https://example.com/1', date: '2024-01-01', description: 'a' },
    ]);
    const viewPanelId = await createViewOver(page, tableId);
    return { tablePanelId: panelDomId(tableId), viewPanelId, tableId };
  }

  test('table fronted last stays above the view after a reload', async ({ page }) => {
    const { tablePanelId, viewPanelId, tableId } = await makeTableAndView(page);

    // Front the view first, then the TABLE last — the table should win.
    await front(page, viewPanelId);
    await front(page, tablePanelId);
    // The table's front-rank write is the one we can observe directly (views
    // don't stamp one pre-fix — see the module doc above).
    await expect
      .poll(async () => (await readTable(page, tableId))?.windowGeometry?.z ?? 0)
      .toBeGreaterThan(0);

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, tableId);
    await page.locator(`#${viewPanelId}`).waitFor();

    // The cross-kind restack (`restack.ts`) that fixes the ordering runs
    // asynchronously after boot (it retries until both panels are registered,
    // then fronts them) — poll rather than asserting the instant both panel
    // DOM nodes exist.
    await expect
      .poll(async () => {
        const tableZ = await zIndexOf(page, tablePanelId);
        const viewZ = await zIndexOf(page, viewPanelId);
        return tableZ > viewZ;
      })
      .toBe(true);
  });

  test('view fronted last stays above the table after a reload', async ({ page }) => {
    const { tablePanelId, viewPanelId, tableId } = await makeTableAndView(page);

    // Front the table first, then the VIEW last — the view should win.
    await front(page, tablePanelId);
    await expect
      .poll(async () => (await readTable(page, tableId))?.windowGeometry?.z ?? 0)
      .toBeGreaterThan(0);
    await front(page, viewPanelId);
    // Give the view's own async front-rank write a moment to persist before
    // reloading (no store helper for view instances in e2e/helpers.ts yet).
    await page.waitForTimeout(200);

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, tableId);
    await page.locator(`#${viewPanelId}`).waitFor();

    // See the comment in the previous test — the restack runs asynchronously.
    await expect
      .poll(async () => {
        const tableZ = await zIndexOf(page, tablePanelId);
        const viewZ = await zIndexOf(page, viewPanelId);
        return viewZ > tableZ;
      })
      .toBe(true);
  });
});
