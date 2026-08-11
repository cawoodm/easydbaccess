import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Docked visualizations: a pane mounted above or below the grid inside the
 * table's own window, rather than in a window of its own.
 *
 * Two behaviours here are the whole point of docking, and neither is visible from
 * the data model alone:
 *  - a docked chart follows the GRID's live filters, because the grid publishes
 *    its filtered row set (`table/visible-rows.ts`) instead of the pane reading
 *    the store a second time;
 *  - minimizing the window drops the pane with the grid, so a collapsed window
 *    holds no chart instance and no subscription.
 *
 * There is also a regression check that a window with NO pane is unchanged — the
 * property the panel-stack design leans on, since every table window now goes
 * through it.
 */

const ROWS = [
  { country: 'CH', amount: 10 },
  { country: 'CH', amount: 7 },
  { country: 'DE', amount: 5 },
  { country: 'AT', amount: 1 },
];

async function seed(page: import('@playwright/test').Page) {
  const id = await createTable(page, 'Sales', [
    { field: 'country', renderer: 'link' },
    { field: 'amount', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, ROWS);
  return id;
}

async function dockChart(page: import('@playwright/test').Page, tableId: string, edge: 'above' | 'below') {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '+ New chart' }).click();
  await dlg.locator('input[type=text]').first().fill('Docked');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.locator('ul.list li', { hasText: 'Docked' }).getByRole('button', { name: 'Use' }).click();
  await dlg.locator('select').first().selectOption(edge);
  await dlg.getByRole('button', { name: 'Create view' }).click();
  // The dialog is modal: while it is up it owns the top layer, so a click aimed
  // at the pane behind it lands on the backdrop instead of the button. Wait for it
  // to be gone AND detached before touching the window underneath.
  await expect(dlg).toBeHidden();
  await expect(page.locator('views-dialog dialog[open]')).toHaveCount(0);
}

test.describe('visualization docking', () => {
  test('a table window with no pane renders exactly as before', async ({ page }) => {
    // The property the whole panel-stack design rests on: every table window goes
    // through the stack now, so an EMPTY stack must be transparent.
    const id = await seed(page);
    const panel = page.locator(`#${panelDomId(id)}`);
    const grid = panel.locator('data-table');
    await expect(grid).toBeVisible();
    await expect(panel.locator('.panel-stack-pane')).toHaveCount(0);
    await expect(panel.locator('.panel-stack-splitter')).toHaveCount(0);
    // The grid still fills the content area.
    const box = await grid.boundingBox();
    const host = await panel.locator('.jsPanel-content').boundingBox();
    expect(box!.height).toBeGreaterThan((host!.height ?? 0) - 4);
  });

  test('a chart docks above the grid, inside the same window', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'above');

    const panel = page.locator(`#${panelDomId(id)}`);
    const pane = panel.locator('viz-pane');
    await expect(pane).toBeVisible();
    // Same window: the pane is inside this panel, and no separate viz window opened.
    await expect(panel.locator('data-table')).toBeVisible();
    await expect(panel.locator('.panel-stack-above viz-pane')).toHaveCount(1);
    // Above means above: the pane's top edge is over the grid's.
    const paneBox = await pane.boundingBox();
    const gridBox = await panel.locator('data-table').boundingBox();
    expect(paneBox!.y).toBeLessThan(gridBox!.y);
  });

  test('a docked chart follows the grid’s filter', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const chart = page.locator(`#${panelDomId(id)} viz-pane viz-bar-chart`);
    const rows = chart.locator('table.a11y tbody tr');
    await expect(rows).toHaveCount(3); // CH, DE, AT

    // Filter the GRID; the chart must narrow with it. This is the assertion the
    // publish-instead-of-fetch design exists for — two independent reads would
    // eventually disagree here.
    const funnel = page.locator(`#${panelDomId(id)} data-table filter-combobox`).first();
    await funnel.locator('input').fill('CH');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('th')).toHaveText('CH');
  });

  test('minimizing the window unmounts the docked pane with the grid', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'below');
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('viz-pane')).toBeVisible();

    await panel.locator('.jsPanel-btn-minimize').click();
    // Both go: a minimized window holds no chart instance and no row subscription.
    await expect(panel.locator('viz-pane')).toHaveCount(0);
    await expect(panel.locator('data-table')).toHaveCount(0);

    // Restoring brings both back.
    await page.locator('#easydb-minimized-dock').getByText('Sales', { exact: false }).first().click();
    await expect(panel.locator('data-table')).toBeVisible();
    await expect(panel.locator('viz-pane')).toBeVisible();
  });

  test('the splitter height persists across a reload', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const panel = page.locator(`#${panelDomId(id)}`);
    const splitter = panel.locator('.panel-stack-splitter').first();
    await expect(splitter).toBeVisible();

    const before = (await panel.locator('.panel-stack-pane').first().boundingBox())!.height;
    const box = (await splitter.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 60, { steps: 8 });
    await page.mouse.up();

    const after = (await panel.locator('.panel-stack-pane').first().boundingBox())!.height;
    expect(after).toBeGreaterThan(before + 20);

    // Persisted on release, not per pointermove — so it survives a reload.
    await page.reload();
    await waitForPanel(page, id);
    const restored = (await page
      .locator(`#${panelDomId(id)} .panel-stack-pane`)
      .first()
      .boundingBox())!.height;
    expect(Math.abs(restored - after)).toBeLessThan(12);
  });

  test('undocking moves the chart into its own window', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('viz-pane').getByRole('button', { name: 'Open in its own window' }).click();

    // Gone from the host, present as a window — one reconciler, both routes.
    await expect(panel.locator('viz-pane')).toHaveCount(0);
    await expect(page.locator('viz-panel')).toBeVisible();
  });

  test('closing a pane leaves the grid alone', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'below');
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('viz-pane viz-bar-chart')).toBeVisible();
    // Activated from the keyboard rather than with a synthesized mouse click.
    // Playwright's pointer click on this particular button does not reach the
    // shadow-root listener (the pane sits inside the pointer-events:none canvas
    // overlay); a real DOM click and the keyboard both do, and Enter on a focused
    // button is a user path worth covering anyway.
    const closeBtn = panel.locator('viz-pane').getByRole('button', { name: 'Close' });
    await closeBtn.focus();
    await closeBtn.press('Enter');
    await expect(panel.locator('viz-pane')).toHaveCount(0);
    await expect(panel.locator('data-table')).toBeVisible();
  });
});
