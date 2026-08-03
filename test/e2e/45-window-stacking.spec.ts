import { test, expect, type Page } from './fixtures.js';
import {
  bulkAddRows,
  createTable,
  panelDomId,
  readTable,
  readViewInstance,
  viewInstanceIdOf,
  waitForPanel,
} from './helpers.js';

/**
 * Table windows (`table-window-manager.ts`) and view windows (`view-window-manager.ts`)
 * are two independent managers, each with its own liveQuery subscription. A
 * saved z only reproduced the order WITHIN one manager's own boot loop — the
 * relative order BETWEEN a table and a view was decided by whichever manager
 * happened to create its panel last (tables always open before views — see
 * `table-list.ts`), not by which one was actually fronted last. See
 * `window-mgr/z-order.ts` + `window-mgr/restack.ts` for the merged-order fix.
 */
test.describe('window stacking across tables and views', () => {
  /** Creates an RSS-templated view over `tableId` via the real dialog flow
   * (mirrors `e2e/23-views.spec.ts`). Returns the view's panel DOM id.
   *
   * Counts view PANELS (`[id^="view-panel-"]`), not `<view-window>` elements,
   * and resolves via the LAST one once the count grows: a caller creating a
   * SECOND view (over the same or another table) needs the NEW panel, not
   * the first one. Two problems rule out the obvious `view-window`-based
   * approaches: (1) `document.querySelector('view-window')` always returns
   * the FIRST match, so a second call would silently return the first view's
   * id every time; (2) asserting `page.locator('view-window')` is VISIBLE is
   * a strict-mode violation the moment a second view exists (Playwright
   * refuses to resolve "is it visible" against >1 match, even mid-load with
   * one still showing "Loading…") — it doesn't matter that only the new one
   * is loading, the query itself is already ambiguous. Panel DOM ids are
   * unique per view instance and exist immediately (even before the inner
   * <view-window> mounts), so polling their count sidesteps both. */
  async function createViewOver(page: Page, tableId: string): Promise<string> {
    const before = await page.evaluate(
      () => document.querySelectorAll('[id^="view-panel-"]').length,
    );
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
    await expect
      .poll(() => page.evaluate(() => document.querySelectorAll('[id^="view-panel-"]').length))
      .toBeGreaterThan(before);
    const panelId = await page.evaluate(() => {
      const panels = [...document.querySelectorAll('[id^="view-panel-"]')];
      return panels[panels.length - 1]!.id;
    });
    // The panel exists before its <view-window> mounts, and a caller that fronts
    // the panel immediately would race that mount. Scoping the wait to THIS
    // panel's id keeps it unambiguous with several views open — the reason the
    // count poll above cannot simply wait on `page.locator('view-window')`.
    await page.locator(`#${panelId} view-window`).waitFor();
    return panelId;
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

  /** The front rank a view window has PERSISTED, 0 before its first front. */
  async function storedViewZ(page: Page, viewPanelId: string): Promise<number> {
    const inst = await readViewInstance(page, viewInstanceIdOf(viewPanelId));
    return inst?.windowGeometry?.z ?? 0;
  }

  /**
   * Front a view AND wait for its front-rank write to land.
   *
   * The write is asynchronous, and these tests reload to check the restored
   * order — so a front whose rank never reached the store is a front that never
   * happened, and the next front would out-rank it in the wrong direction. The
   * rank is a session-monotonic counter, so "landed" is "greater than the rank it
   * had before" (a fixed sleep used to stand in for this).
   */
  async function frontView(page: Page, viewPanelId: string): Promise<void> {
    const before = await storedViewZ(page, viewPanelId);
    await front(page, viewPanelId);
    await expect.poll(() => storedViewZ(page, viewPanelId)).toBeGreaterThan(before);
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
    await frontView(page, viewPanelId);

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

  test('a table/view/table sandwich preserves interleaved stacking after a reload', async ({
    page,
  }) => {
    // An additional stacking-restore case alongside the two above: a single
    // view sandwiched between two tables. NOTE: this shape does NOT pin the
    // old jsPanel-bridge regression (see the view/table/view test below for
    // that) — with only one view in play, the bridge's block-wide
    // renormalization of every jsPanel-side panel moves just that one view,
    // so any relative position was still reproducible even pre-swap.
    // Create the view over table A before table B exists, so table A's own
    // panel-footer is still on top and clickable (table B would otherwise
    // cascade-position on top of it, per createTable's default placement).
    const tableAId = await createTable(page, 'TableA', [{ field: 'title' }]);
    await waitForPanel(page, tableAId);
    const viewPanelId = await createViewOver(page, tableAId);
    const tableBId = await createTable(page, 'TableB', [{ field: 'title' }]);
    await waitForPanel(page, tableBId);

    const tableAPanelId = panelDomId(tableAId);
    const tableBPanelId = panelDomId(tableBId);

    // Front bottom → top: TableB, then the view, then TableA — a table/view/
    // table sandwich (the view sits between the two tables, not above/below
    // both of them).
    await front(page, tableBPanelId);
    await expect
      .poll(async () => (await readTable(page, tableBId))?.windowGeometry?.z ?? 0)
      .toBeGreaterThan(0);
    await frontView(page, viewPanelId);
    await front(page, tableAPanelId);
    await expect
      .poll(async () => (await readTable(page, tableAId))?.windowGeometry?.z ?? 0)
      .toBeGreaterThan(0);

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, tableAId);
    await waitForPanel(page, tableBId);
    await page.locator(`#${viewPanelId}`).waitFor();

    // The cross-kind restack runs asynchronously after boot — poll until the
    // full sandwich order settles: B below the view, the view below A.
    await expect
      .poll(async () => {
        const bZ = await zIndexOf(page, tableBPanelId);
        const vZ = await zIndexOf(page, viewPanelId);
        const aZ = await zIndexOf(page, tableAPanelId);
        return bZ < vZ && vZ < aZ;
      })
      .toBe(true);
  });

  test('a view/table/view sandwich preserves interleaved stacking after a reload — the actual bridge-regression pin', async ({
    page,
  }) => {
    // THIS is the shape the old jsPanel z-order bridge (`bridgeJsPanelZOrder`,
    // removed in the view-window-manager swap) could not reproduce. With only
    // ONE view in play (see the table/view/table test above), the bridge's
    // renormalization touches just that one jsPanel-side panel, so any
    // relative position was still reproducible. With TWO views straddling one
    // table, fronting the upper view renormalized EVERY jsPanel panel as one
    // block — dragging the lower view up along with it — so a saved
    // `viewLower < table < viewUpper` order restored as
    // `table < viewLower < viewUpper` instead. Now that both kinds share one
    // z-index numbering (panel-shell.ts's `nextZ()`), there is no second
    // registry to renormalize, so the sandwich survives a reload intact.
    const tableAId = await createTable(page, 'TableA', [{ field: 'title' }]);
    await waitForPanel(page, tableAId);
    const viewLowerPanelId = await createViewOver(page, tableAId);
    const viewUpperPanelId = await createViewOver(page, tableAId);
    const tableAPanelId = panelDomId(tableAId);

    // Front bottom → top: the lower view, then the table, then the upper view.
    await frontView(page, viewLowerPanelId);
    await front(page, tableAPanelId);
    await expect
      .poll(async () => (await readTable(page, tableAId))?.windowGeometry?.z ?? 0)
      .toBeGreaterThan(0);
    await frontView(page, viewUpperPanelId);

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, tableAId);
    await page.locator(`#${viewLowerPanelId}`).waitFor();
    await page.locator(`#${viewUpperPanelId}`).waitFor();

    // The cross-kind restack runs asynchronously after boot — poll until the
    // full sandwich order settles: the lower view below the table, the table
    // below the upper view.
    await expect
      .poll(async () => {
        const lowerZ = await zIndexOf(page, viewLowerPanelId);
        const tableZ = await zIndexOf(page, tableAPanelId);
        const upperZ = await zIndexOf(page, viewUpperPanelId);
        return lowerZ < tableZ && tableZ < upperZ;
      })
      .toBe(true);
  });
});
