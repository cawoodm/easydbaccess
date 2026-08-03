import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Each window kind (window-mgr/table-kind.ts) gets its own SVG icon at the
 * far left of the jsPanel titlebar (jsPanel's `headerLogo` slot), and
 * refreshable tables (source- or origin-backed) get a distinct panel colour
 * from `panelColor()`, carried by the shell's `--eda-panel-color`.
 *
 * The second test patches `source` onto an already-open plain table with a
 * source.type NOT registered by any built-in plugin (only 'url' and
 * 'datasette' are). `routed-data-store.ts` treats an unregistered type as a
 * strict no-op — `rows()` falls back to the local Dexie collection — so this
 * exercises the runtime kind-change path (icon + colour update without
 * reopening the window) with no network mocking required.
 */
const LOCAL = '#01579b';
const REFRESHABLE = '#6d28d9';

/** The chrome colour the shell is painting this panel (or dock bar) with. */
const panelColorOf = (page: import('@playwright/test').Page, domId: string) =>
  page.evaluate(
    (d) =>
      document.getElementById(d)!.style.getPropertyValue('--eda-panel-color').trim().toLowerCase(),
    domId,
  );

test.describe('panel titlebar kind icons', () => {
  test('a plain local table shows the normal icon and the local colour', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);

    const icon = page.locator(`#${panelDomId(id)} .jsPanel-headerlogo svg`);
    await expect(icon).toHaveAttribute('aria-label', 'Local table');
    expect(await panelColorOf(page, panelDomId(id))).toBe(LOCAL);
  });

  test('a table with a source shows the connected icon and the refreshable colour', async ({
    page,
  }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);

    // Starts as a plain local table (normal icon, local colour).
    const icon = page.locator(`#${panelDomId(id)} .jsPanel-headerlogo svg`);
    await expect(icon).toHaveAttribute('aria-label', 'Local table');
    const panel = page.locator(`#${panelDomId(id)}`);
    expect(await panelColorOf(page, panelDomId(id))).toBe(LOCAL);

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
    await expect.poll(() => panelColorOf(page, panelDomId(id))).toBe(REFRESHABLE);
    await expect(panel).toBeVisible();
  });

  test('a minimized window keeps its colour in the dock', async ({ page }) => {
    // The colour used to be a CSS class on the window only, so a refreshable
    // table docked as a plain local one.
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);
    await page.evaluate(async (tableId) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.tables.patch(tableId, {
        source: { type: 'unregistered-test-backend', config: {} },
        updatedAt: Date.now(),
      });
    }, id);
    await expect.poll(() => panelColorOf(page, panelDomId(id))).toBe(REFRESHABLE);

    await page.locator(`#${panelDomId(id)} .jsPanel-btn-minimize`).click();
    const bar = page.locator('#easydb-minimized-dock .jsPanel-replacement');
    await expect(bar).toHaveCount(1);
    expect(await panelColorOf(page, `${panelDomId(id)}-min`)).toBe(REFRESHABLE);
  });

  test('a view window keeps its own colour in the dock', async ({ page, workspaceId }) => {
    const tableId = await createTable(page, 'Feed', [{ field: 'title' }]);
    await waitForPanel(page, tableId);
    await page.evaluate(
      async ({ tableId, ws }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const templates = await store.viewTemplates.find({ workspaceId: ws });
        const rss = (templates as Array<{ id: string; name: string }>).find(
          (t) => t.name === 'RSS Feed',
        )!;
        await store.viewInstances.insert({
          id: 'colour-view',
          workspaceId: ws,
          tableId,
          templateId: rss.id,
          name: 'Coloured',
          filters: {},
          mapping: { TITLE: 'title' },
          visibleColumns: ['title'],
          open: true,
          updatedAt: Date.now(),
        });
      },
      { tableId, ws: workspaceId },
    );
    const viewPanel = page.locator('[id^="view-panel-"]');
    await expect(viewPanel).toBeVisible();
    const domId = (await viewPanel.getAttribute('id'))!;
    const cyan = await panelColorOf(page, domId);
    expect(cyan).toBe('#0891b2');

    await viewPanel.locator('.jsPanel-btn-minimize').click();
    await expect(page.locator('#easydb-minimized-dock .jsPanel-replacement')).toHaveCount(1);
    expect(await panelColorOf(page, `${domId}-min`)).toBe(cyan);
  });
});
