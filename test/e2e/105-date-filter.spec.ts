import { expect, test, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A `date` column's funnel opens `date-filter-popover` — named presets ("Last
 * 3 months", "Year to date") and a from/to range — instead of the stock
 * distinct-value list. The ← button is the one route back to exact-value
 * picking, so it gets its own test.
 *
 * Rows are seeded relative to the run date so "Last 3 months" always has
 * something inside it and something outside it, whenever the suite runs.
 */

const today = new Date();
const daysAgo = (n: number) => {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const panel = (page: Page, id: string) => page.locator(`#${panelDomId(id)}`);
const funnel = (page: Page, id: string) => panel(page, id).locator('data-table thead th button.funnel').first();
const rows = (page: Page, id: string) => panel(page, id).locator('data-table tbody tr:not(.spacer):visible');

async function seed(page: Page): Promise<string> {
  const id = await createTable(page, 'Dates', [{ field: 'when', type: 'date' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ when: daysAgo(5) }, { when: daysAgo(40) }, { when: daysAgo(200) }, { when: daysAgo(500) }]);
  await expect(rows(page, id)).toHaveCount(4);
  return id;
}

/** Flip `when` from a `date` column to a `string` one rendered as `date` — how `cell-date` documents applying itself. */
async function makeStringRenderedAsDate(page: Page, id: string): Promise<void> {
  await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = await ctx.store.tables.findOne(tableId);
    await ctx.store.tables.patch(tableId, {
      columns: t.columns.map((c: { field: string }) => (c.field === 'when' ? { ...c, type: 'string', renderer: 'date' } : c)),
      updatedAt: Date.now(),
    });
  }, id);
  // The grid's own column list updates off a store broadcast, not the patch's
  // return value — wait for it directly rather than racing a funnel click
  // against a subscription that has not fired yet.
  await page.waitForFunction(
    ({ pid, field }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dt = document.querySelector(`#${pid} data-table`) as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const col = dt?.columns?.find((c: any) => c.field === field);
      return col?.type === 'string' && col?.renderer === 'date';
    },
    { pid: panelDomId(id), field: 'when' },
    { timeout: 10_000 },
  );
}

test.describe('date filter dropdown', () => {
  test('the funnel on a date column opens the date panel', async ({ page }) => {
    const id = await seed(page);
    await funnel(page, id).click();

    const popover = page.locator('date-filter-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByText('Last 3 months')).toBeVisible();
    await expect(popover.getByText('Year to date')).toBeVisible();
  });

  test('a preset narrows the grid and stays applied', async ({ page }) => {
    const id = await seed(page);
    await funnel(page, id).click();

    const popover = page.locator('date-filter-popover');
    await popover.getByText('Last 3 months').click();

    // daysAgo(5) and daysAgo(40) are inside the last 3 months; 200 and 500 are not.
    await expect(rows(page, id)).toHaveCount(2);
    // The panel stays open and marks the active preset.
    await expect(popover).toBeVisible();
    await expect(popover.locator('li.active')).toHaveText(/Last 3 months/);
  });

  test('a from/to range narrows the grid', async ({ page }) => {
    const id = await seed(page);
    await funnel(page, id).click();

    const from = page.locator('#date-filter-from');
    const to = page.locator('#date-filter-to');
    await from.fill(daysAgo(50));
    await from.dispatchEvent('change');
    await to.fill(daysAgo(1));
    await to.dispatchEvent('change');

    await expect(rows(page, id)).toHaveCount(2);
  });

  test('the back button returns to the value list', async ({ page }) => {
    const id = await seed(page);
    await funnel(page, id).click();

    const popover = page.locator('date-filter-popover');
    await expect(popover).toBeVisible();
    await popover.locator('button[aria-label="Back to the list of values"]').click();

    await expect(popover).toBeHidden();
    await expect(page.locator('filter-popover')).toBeVisible();
  });

  test('clear empties the filter', async ({ page }) => {
    const id = await seed(page);
    await funnel(page, id).click();

    const popover = page.locator('date-filter-popover');
    await popover.getByText('Last 3 months').click();
    await expect(rows(page, id)).toHaveCount(2);

    await popover.getByRole('button', { name: 'Clear filter' }).click();
    await expect(rows(page, id)).toHaveCount(4);
  });

  test('a string column rendered as a date also gets the panel', async ({ page }) => {
    const id = await seed(page);
    await makeStringRenderedAsDate(page, id);

    await funnel(page, id).click();
    await expect(page.locator('date-filter-popover')).toBeVisible();
  });
});
