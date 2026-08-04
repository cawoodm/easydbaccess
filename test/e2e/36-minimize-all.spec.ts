import { expect, type Page } from '@playwright/test';
import { test as appTest } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * `?minimize` — the rescue hatch for a workspace whose tables are too big to
 * load. Every table opens minimized, so no `<data-table>` mounts, no rows are
 * held in memory and a live table fetches nothing until the user expands it.
 *
 * The load-bearing assertions are (1) no grid is mounted on boot, and (2) the
 * override is NOT persisted — one visit to `?minimize` must not leave every
 * table minimized forever.
 */

async function reopen(page: Page, ws: string, query = '') {
  await page.goto(`/?test=1&space=${encodeURIComponent(ws)}${query}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await page.waitForFunction(() => Boolean((window as any).__easydb), { timeout: 15_000 });
}

appTest('?minimize opens every table minimized and mounts no grid', async ({ page, workspaceId }) => {
  const a = await createTable(page, 'alpha', [{ field: 'n', label: 'N', type: 'number' }]);
  const b = await createTable(page, 'beta', [{ field: 'n', label: 'N', type: 'number' }]);
  await waitForPanel(page, a);
  await waitForPanel(page, b);

  // Normally the panels mount a grid.
  expect(await page.locator('data-table').count()).toBeGreaterThan(0);

  await reopen(page, workspaceId, '&minimize');
  await waitForPanel(page, a);
  await waitForPanel(page, b);

  // Both panels exist, and NOTHING mounted a grid.
  await expect(page.locator(`#${panelDomId(a)}`)).toHaveCount(1);
  await expect(page.locator(`#${panelDomId(b)}`)).toHaveCount(1);
  await expect.poll(async () => page.locator('data-table').count()).toBe(0);
});

appTest('?minimize is not persisted — a later visit restores the real layout', async ({ page, workspaceId }) => {
  const a = await createTable(page, 'gamma', [{ field: 'n', label: 'N', type: 'number' }]);
  await waitForPanel(page, a);

  await reopen(page, workspaceId, '&minimize');
  await waitForPanel(page, a);
  await expect.poll(async () => page.locator('data-table').count()).toBe(0);

  // Reopen WITHOUT the flag: the grid is back, because the forced minimize was
  // never written to the table's windowGeometry.
  await reopen(page, workspaceId);
  await waitForPanel(page, a);
  await expect.poll(async () => page.locator('data-table').count()).toBeGreaterThan(0);
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = await store.tables.findOne(id);
        return t?.windowGeometry?.minimized === true ? 'minimized' : 'normal';
      }, a),
    )
    .toBe('normal');
});

appTest('?minimize=0 is off, so the grid still mounts', async ({ page, workspaceId }) => {
  const a = await createTable(page, 'delta', [{ field: 'n', label: 'N', type: 'number' }]);
  await waitForPanel(page, a);

  await reopen(page, workspaceId, '&minimize=0');
  await waitForPanel(page, a);
  await expect.poll(async () => page.locator('data-table').count()).toBeGreaterThan(0);
});
