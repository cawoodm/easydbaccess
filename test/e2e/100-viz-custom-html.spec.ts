import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `custom` visualization: the user's own HTML drawn over the rows the grid
 * is showing.
 *
 * Three things here cannot be checked from the data model, and each is the point
 * of a different piece of the feature:
 *  - the tokens are DATASET-level, so `$COUNT` is one number for the whole set
 *    rather than a fragment repeated per row (which is what a view window is);
 *  - a `$filter.` pill narrows the HOST GRID — the "two-way street" — and the
 *    pane then redraws from the narrowed set, which is only true because the
 *    grid republishes and the pane never reads the store;
 *  - a broken script says so instead of leaving a blank pane, since a blank pane
 *    is indistinguishable from a table with no data.
 */

const ROWS = [
  { country: 'CH', amount: 10 },
  { country: 'CH', amount: 7 },
  { country: 'DE', amount: 5 },
  { country: 'AT', amount: 1 },
];

const HTML = '<p>Rows: <b id="n">$COUNT</b> Total: <b id="t">$SUM.amount</b></p><div id="pills">$filter.country</div>';

async function seed(page: import('@playwright/test').Page) {
  const id = await createTable(page, 'Sales', [
    { field: 'country', renderer: 'link' },
    { field: 'amount', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, ROWS);
  return id;
}

/** Create a Custom HTML template and dock an instance of it below the grid. */
async function dockCustom(page: import('@playwright/test').Page, tableId: string, opts: { html: string; script?: string; where?: 'below' | 'window' }) {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '+ New visualization' }).click();
  await dlg.locator('input[type=text]').first().fill('Header');
  await dlg.locator('select').first().selectOption('custom');
  // The two `code` options, in declared order: HTML then Script.
  const boxes = dlg.locator('.code-field textarea');
  await expect(boxes).toHaveCount(2);
  await boxes.nth(0).fill(opts.html);
  if (opts.script) await boxes.nth(1).fill(opts.script);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.locator('ul.list li', { hasText: 'Header' }).getByRole('button', { name: 'Use' }).click();
  await dlg.locator('select').first().selectOption(opts.where ?? 'below');
  await dlg.getByRole('button', { name: 'Create view' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('views-dialog dialog[open]')).toHaveCount(0);
}

test.describe('custom HTML visualization', () => {
  test('draws dataset-level tokens over the rows the grid is showing', async ({ page }) => {
    const id = await seed(page);
    await dockCustom(page, id, { html: HTML });

    const canvas = page.locator(`#${panelDomId(id)} viz-custom-html .canvas`);
    await expect(canvas.locator('#n')).toHaveText('4');
    await expect(canvas.locator('#t')).toHaveText('23');
    // One pill per DISTINCT value, not one per row — three countries, four rows.
    await expect(canvas.locator('#pills .eda-filter-pill')).toHaveCount(3);
  });

  test('clicking a pill narrows the host grid, and the pane redraws from it', async ({ page }) => {
    const id = await seed(page);
    await dockCustom(page, id, { html: HTML });

    const panel = page.locator(`#${panelDomId(id)}`);
    const canvas = panel.locator('viz-custom-html .canvas');
    await expect(panel.locator('data-table tbody tr')).toHaveCount(4);

    await canvas.locator('.eda-filter-pill', { hasText: 'CH' }).click();

    // The GRID narrows — this is the two-way street, and it is the grid's own
    // filter, so its funnel is where it shows and where it clears.
    await expect(panel.locator('data-table tbody tr')).toHaveCount(2);
    // …and the pane follows, because the grid republishes what it now shows.
    await expect(canvas.locator('#n')).toHaveText('2');
    await expect(canvas.locator('#t')).toHaveText('17');
    await expect(canvas.locator('#pills .eda-filter-pill')).toHaveCount(1);
  });

  test('a script can build the picture itself and ask the grid to filter', async ({ page }) => {
    const id = await seed(page);
    await dockCustom(page, id, {
      html: '',
      script: `function render(rows, api) {
  const b = document.createElement('button');
  b.id = 'only-ch';
  b.textContent = 'CH only (' + rows.length + ')';
  b.addEventListener('click', () => api.filter('country', 'CH'));
  api.el.replaceChildren(b);
}`,
    });

    const panel = page.locator(`#${panelDomId(id)}`);
    const button = panel.locator('viz-custom-html #only-ch');
    await expect(button).toHaveText('CH only (4)');
    await button.click();
    await expect(panel.locator('data-table tbody tr')).toHaveCount(2);
    await expect(button).toHaveText('CH only (2)');
  });

  test('a broken script says so instead of leaving a blank pane', async ({ page }) => {
    const id = await seed(page);
    await dockCustom(page, id, { html: HTML, script: 'function render(rows, api) { throw new Error("boom"); }' });

    const pane = page.locator(`#${panelDomId(id)} viz-custom-html`);
    await expect(pane.locator('.error')).toContainText('boom');
    await expect(pane.locator('.error')).toContainText('runtime error');
  });
});

test.describe('commandlet links in a custom visualization', () => {
  test('a #goto with no table name acts on the table the pane is in', async ({ page }) => {
    const id = await seed(page);
    await dockCustom(page, id, { html: '<a id="only-ch" href="#goto?country==CH">CH</a> <a id="reset" href="#goto?@clear">reset</a>' });

    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('data-table tbody tr')).toHaveCount(4);
    await panel.locator('viz-custom-html #only-ch').click();
    await expect(panel.locator('data-table tbody tr')).toHaveCount(2);
    await panel.locator('viz-custom-html #reset').click();
    await expect(panel.locator('data-table tbody tr')).toHaveCount(4);
  });

  test('…and from a visualization in its OWN window, which is in no table window', async ({ page }) => {
    // The case that failed with "goto with no name means the table you are in —
    // this was not run from one": a windowed visualization sits outside every
    // table panel, so walking the DOM for a table id found nothing. It always
    // draws exactly one table, and now says which.
    const id = await seed(page);
    await dockCustom(page, id, { html: '<a id="only-ch" href="#goto?country==CH">CH</a>', where: 'window' });

    const grid = page.locator(`#${panelDomId(id)} data-table tbody tr`);
    await expect(grid).toHaveCount(4);
    await page.locator('viz-custom-html #only-ch').click();
    await expect(grid).toHaveCount(2);
  });

  test('sorting and searching the current table work the same way', async ({ page }) => {
    const id = await seed(page);
    await dockCustom(page, id, {
      html: '<a id="asc" href="#goto?@sort=amount">smallest first</a> <a id="desc" href="#goto?@sort=-amount">biggest first</a> <a id="q" href="#goto?@search=DE">find DE</a>',
    });

    const panel = page.locator(`#${panelDomId(id)}`);
    // Amounts are 10, 7, 5, 1 — read the FIRST row's number each way round, so a
    // sort that silently did nothing cannot pass by matching the natural order.
    const firstAmount = () => panel.locator('data-table tbody tr td.t-number').first().getAttribute('title');
    await panel.locator('viz-custom-html #asc').click();
    await expect.poll(firstAmount).toBe('1');
    await panel.locator('viz-custom-html #desc').click();
    await expect.poll(firstAmount).toBe('10');

    await panel.locator('viz-custom-html #q').click();
    await expect(panel.locator('data-table tbody tr')).toHaveCount(1);
  });
});
