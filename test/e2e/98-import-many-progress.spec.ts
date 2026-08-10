import { test, expect } from './fixtures.js';

/**
 * Importing a whole database creates every table window first and fills them one
 * at a time. The queued windows used to show nothing at all — an empty grid, no
 * bar — which reads as "this table is empty", not "this table is next". So every
 * window flashes from the moment it appears, and one app-wide bar counts the
 * batch: indeterminate while nothing has reported, then a percentage.
 */

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

const ROWS = [
  { id: 1, name: 'A' },
  { id: 2, name: 'B' },
];

test.describe('importing many tables', () => {
  test.beforeEach(async ({ page }) => {
    // Three tables. The FIRST one's rows are slow, so the other two are still
    // queued — which is the state under test — for a good two seconds.
    await page.route('https://inst.example/**', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/shop.json') {
        return route.fulfill(
          json({
            ok: true,
            tables: [
              { name: 'slow', count: 2, primary_keys: ['id'] },
              { name: 'quick', count: 2, primary_keys: ['id'] },
              { name: 'last', count: 2, primary_keys: ['id'] },
            ],
          }),
        );
      }
      const m = /^\/shop\/(slow|quick|last)\.json$/.exec(u.pathname);
      if (!m) return route.fulfill({ status: 404, body: '{"ok":false}' });
      if ((u.searchParams.get('_extra') ?? '').includes('columns')) return route.fulfill(json({ ok: true, columns: ['id', 'name'], rows: [] }));
      if (m[1] === 'slow') await new Promise((r) => setTimeout(r, 2000));
      return route.fulfill(json({ ok: true, next: null, rows: ROWS }));
    });
  });

  const startImport = async (page: import('@playwright/test').Page) => {
    await page.getByTitle('Import data from a URL').click();
    const dlg = page.locator('import-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('input[type="text"]').fill('https://inst.example/shop');
    await dlg.getByTestId('import-format').selectOption('datasette');
    await dlg.getByRole('button', { name: 'Import', exact: true }).click();
    await page
      .locator('table-select-dialog dialog')
      .getByRole('button', { name: /^Import \(3\)$/ })
      .click();
  };

  test('every window flashes at once, and the app bar counts the batch', async ({ page, workspaceId }) => {
    await startImport(page);

    // The app-wide bar says what is happening straight away, and it is
    // INDETERMINATE — no table has reported a row yet, so a number would be
    // invented.
    const bar = page.locator('app-progress .wrap');
    await expect(bar).toContainText('Importing 3 tables');
    await expect(bar).toContainText('0 of 3 tables');
    // (Asserted on the class, not visibility: the indeterminate fill is a sliver
    // animated right out of its own clip, so it is off screen half the time.)
    await expect(page.locator('app-progress .fill')).not.toHaveClass(/determinate/);
    await expect(page.locator('app-progress .pct')).toHaveText('');

    // All three windows exist and all three show a bar — including the two that
    // are only queued behind the slow one.
    await expect(page.locator('data-table')).toHaveCount(3);
    await expect(page.locator('data-table .load-bar')).toHaveCount(3);

    // Once tables land the app bar turns proportional and counts them off.
    await expect(page.locator('app-progress .fill')).toHaveClass(/determinate/, { timeout: 15_000 });
    await expect(bar).toContainText('%');

    // Everything imported: the bar goes away and no window is left flashing.
    await expect
      .poll(
        () =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const store = (window as any).__easydb.store;
            const tables = (await store.tables.find()).filter((t: { workspaceId: string }) => t.workspaceId === ws);
            const counts: Record<string, number> = {};
            for (const t of tables) counts[t.name] = (await store.rows(t.id).find()).length;
            return counts;
          }, workspaceId),
        { timeout: 20_000 },
      )
      .toEqual({ 'shop/slow': 2, 'shop/quick': 2, 'shop/last': 2 });

    await expect(page.locator('app-progress .wrap')).toHaveCount(0);
    await expect(page.locator('data-table .load-bar')).toHaveCount(0);
  });
});
