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
  await dlg.getByRole('button', { name: '+ New visualization' }).click();
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

    // Persisted on release, not per pointermove — so it survives a reload. Wait
    // for the WRITE, not for the pixels: the release only queues it, and a
    // reload that outran the queue used to fail this as if the size had been
    // forgotten.
    await expect
      .poll(async () => {
        const all = await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const insts = await (window as any).__easydb.store.viewInstances.find();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return insts.map((v: any) => v.dock?.size ?? null);
        });
        return all.some((size: number | null) => size != null && Math.abs(size - after) < 12);
      })
      .toBe(true);

    await page.reload();
    await waitForPanel(page, id);
    const restored = (await page
      .locator(`#${panelDomId(id)} .panel-stack-pane`)
      .first()
      .boundingBox())!.height;
    expect(Math.abs(restored - after)).toBeLessThan(12);
  });

  test('collapsing a pane gives its room back to the grid', async ({ page }) => {
    // Collapse used to hide the pane's body and leave the pane's box at full
    // height — an empty rectangle beside the grid rather than a collapse.
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const panel = page.locator(`#${panelDomId(id)}`);
    const wrap = panel.locator('.panel-stack-pane').first();
    const grid = panel.locator('data-table');

    const openH = (await wrap.boundingBox())!.height;
    const gridBefore = (await grid.boundingBox())!.height;
    expect(openH).toBeGreaterThan(60);

    const collapse = panel.locator('viz-pane').getByRole('button', { name: 'Collapse' });
    await collapse.focus();
    await collapse.press('Enter');

    // Down to the header strip, and the splitter goes with it.
    await expect.poll(async () => (await wrap.boundingBox())!.height).toBeLessThan(30);
    await expect(panel.locator('.panel-stack-splitter')).toBeHidden();
    const gridAfter = (await grid.boundingBox())!.height;
    expect(gridAfter).toBeGreaterThan(gridBefore + 30);

    // Expanding restores the height the user had chosen, not a default.
    const expand = panel.locator('viz-pane').getByRole('button', { name: 'Expand' });
    await expand.focus();
    await expand.press('Enter');
    await expect.poll(async () => (await wrap.boundingBox())!.height).toBeGreaterThan(60);
    expect(Math.abs((await wrap.boundingBox())!.height - openH)).toBeLessThan(6);
  });

  test('a word cloud fills its pane instead of sitting in a margin', async ({ page }) => {
    // The layout packs outwards from the centre and stops, so the drawn words
    // covered a fraction of the pane. The viewBox is cropped to them now.
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'alpha beta alpha' }, { body: 'alpha gamma delta' }]);

    const dlg = page.locator('views-dialog dialog');
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    await dlg.getByRole('button', { name: '+ New visualization' }).click();
    await dlg.locator('input[type=text]').first().fill('Cloud');
    await dlg.locator('select').first().selectOption('wordcloud');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.locator('ul.list li', { hasText: 'Cloud' }).getByRole('button', { name: 'Use' }).click();
    await dlg.locator('select').first().selectOption('below');
    await dlg.getByRole('button', { name: 'Create view' }).click();
    await expect(dlg).toBeHidden();

    const cloud = page.locator(`#${panelDomId(id)} viz-pane viz-word-cloud`);
    await expect(cloud.locator('text').first()).toBeVisible();

    // The viewBox is the words' own extent, and the words fill most of it.
    const fill = await cloud.evaluate((el) => {
      const svg = el.shadowRoot!.querySelector('svg')!;
      const vb = svg.getAttribute('viewBox')!.split(' ').map(Number);
      const b = svg.getBBox();
      return { w: (b.width + 4) / (vb[2] ?? 1), h: (b.height + 4) / (vb[3] ?? 1) };
    });
    expect(fill.w).toBeGreaterThan(0.95);
    expect(fill.h).toBeGreaterThan(0.95);

    // No host padding around a cloud — it draws to the pane's edge.
    const pad = await page.locator(`#${panelDomId(id)} viz-pane viz-panel`).evaluate((el) => {
      const chart = el.shadowRoot!.querySelector('.chart')!;
      return getComputedStyle(chart).padding;
    });
    expect(pad).toBe('0px');
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

  test('the pop-in button docks a windowed chart back above its table', async ({ page }) => {
    // The counterpart of the pane strip's "Open in its own window" — a round trip
    // out and back with no visit to the instance form.
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('viz-pane').getByRole('button', { name: 'Open in its own window' }).click();
    await expect(page.locator('viz-panel')).toBeVisible();

    const win = page.locator('.jsPanel', { has: page.locator('viz-panel') });
    await win.locator('viz-footer').getByRole('button', { name: 'Dock above the table' }).click();

    // Back in the host window, above the grid, and the chart still has its data.
    await expect(panel.locator('.panel-stack-above viz-pane')).toHaveCount(1);
    await expect(panel.locator('viz-pane viz-bar-chart table.a11y tbody tr')).toHaveCount(3);
    // No window left behind: a viz window is the only thing with a viz-footer,
    // and the docked pane's own <viz-panel> lives inside the table's window now.
    await expect(page.locator('viz-footer')).toHaveCount(0);
    const state = await page.evaluate(async () => {
      const w = window as unknown as { __easydb: { store: { viewInstances: { find(): Promise<Array<{ open?: boolean; dock?: { edge: string } }>> } } } };
      return (await w.__easydb.store.viewInstances.find()).map((v) => ({ open: v.open, edge: v.dock?.edge ?? null }));
    });
    expect(state[0]).toEqual({ open: true, edge: 'above' });
  });

  test('popping a chart in re-opens a table window that was closed', async ({ page }) => {
    // A pane has nowhere to mount while its host is hidden, so docking into a
    // closed table window would have made the chart disappear outright.
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('viz-pane').getByRole('button', { name: 'Open in its own window' }).click();
    await expect(page.locator('viz-panel')).toBeVisible();

    // Dispatched rather than clicked: the freshly-opened chart window sits over
    // the table's titlebar, so a real pointer click lands on the wrong window.
    await panel.locator('.jsPanel-btn-close').dispatchEvent('click');
    await expect(panel).toHaveCount(0);

    const win = page.locator('.jsPanel', { has: page.locator('viz-footer') });
    await win.locator('viz-footer').getByRole('button', { name: 'Dock above the table' }).click();

    await expect(page.locator(`#${panelDomId(id)}`)).toBeVisible();
    await expect(page.locator(`#${panelDomId(id)} viz-pane`)).toBeVisible();
  });

  test('a docked pane reaches BOTH editors from its strip', async ({ page }) => {
    // A pane has no footer of its own — the host window's footer belongs to the
    // table — so both routes back to the configuration live in the strip. With
    // only one, the definition (kind, aggregate, shared options) was unreachable
    // from a docked pane without undocking it first.
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const pane = page.locator(`#${panelDomId(id)} viz-pane`);
    const dlg = page.locator('views-dialog dialog');

    const settings = pane.getByRole('button', { name: 'Settings for this view' });
    await expect(settings).toBeVisible();
    await settings.focus();
    await settings.press('Enter');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('Map data to columns');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    await pane.getByRole('button', { name: 'Edit definition' }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('What it measures');
  });

  test('moving a windowed chart to docked takes effect immediately', async ({ page }) => {
    // The bug: the window closing on its way to becoming a pane ran the panel's
    // `onclosed`, which writes `open: false` — so the pane the reconcile had just
    // mounted was immediately removed and the chart vanished entirely.
    const id = await seed(page);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.getByRole('button', { name: '+ New visualization' }).click();
    await dlg.locator('input[type=text]').first().fill('Mover');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.locator('ul.list li', { hasText: 'Mover' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    // Starts as its own window.
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(page.locator('viz-panel')).toBeVisible();
    await expect(panel.locator('viz-pane')).toHaveCount(0);

    // Move it to docked from the chart's own Edit form.
    const win = page.locator('.jsPanel', { has: page.locator('viz-panel') });
    await win.locator('viz-footer').getByRole('button', { name: 'Settings for this view' }).click();
    await expect(dlg).toBeVisible();
    await dlg.locator('select').first().selectOption('above');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeHidden();

    // Immediately docked, and it STAYS docked — no window left behind.
    await expect(panel.locator('.panel-stack-above viz-pane')).toHaveCount(1);
    await expect(panel.locator('viz-pane viz-bar-chart')).toBeVisible();
    await expect(page.locator('.jsPanel', { has: page.locator('viz-panel') }).locator('.jsPanel-ftr viz-footer')).toHaveCount(0);

    // `open` must still be true — the pane is shown by the same flag.
    const state = await page.evaluate(async () => {
      const w = window as unknown as { __easydb: { store: { viewInstances: { find(): Promise<Array<{ open?: boolean; dock?: { edge: string } }>> } } } };
      return (await w.__easydb.store.viewInstances.find()).map((v) => ({ open: v.open, edge: v.dock?.edge ?? null }));
    });
    expect(state[0]).toEqual({ open: true, edge: 'above' });
  });

  test('a docked pane and a windowed chart both offer a refresh', async ({ page }) => {
    const id = await seed(page);
    await dockChart(page, id, 'above');
    const pane = page.locator(`#${panelDomId(id)} viz-pane`);
    const refresh = pane.getByRole('button', { name: 'Refresh' });
    await expect(refresh).toBeVisible();

    // Redraws rather than emptying: the numbers are still there afterwards.
    await refresh.focus();
    await refresh.press('Enter');
    await expect(pane.locator('viz-bar-chart table.a11y tbody tr')).toHaveCount(3);
  });

  test('a docked pane on an idle table has data without anyone touching it', async ({ page }) => {
    // The push-only bug: the grid publishes its row set only when something is
    // already listening, but the pane mounts AFTER the grid has rendered. On a
    // reload nobody touches the table, so the next publish never came and the pane
    // sat on "No data to chart." beside a grid showing four rows — permanently, not
    // slowly. Hence the PULL in `viz-panel`'s docked branch.
    const id = await seed(page);
    await dockChart(page, id, 'above');
    await page.reload();
    await waitForPanel(page, id);

    const panel = page.locator(`#${panelDomId(id)}`);
    const chart = panel.locator('viz-pane viz-bar-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('table.a11y tbody tr')).toHaveCount(3);
    await expect(chart).not.toContainText('No data to chart.');
  });

  test('a docked word cloud has its words without a reload or a resize', async ({ page }) => {
    // Same race as above, seen from the word cloud — where it was reported and where
    // it looked worst, because the cloud's own empty state ("No words to show.")
    // reads as a verdict on the data rather than as "not loaded yet". The pane had
    // claimed to be loaded with no rows; resizing the window forced the grid to
    // re-render, and only then did the words appear.
    //
    // Both orderings are covered: docking onto an already-rendered grid (pane after
    // grid, which needs the pull) and a reload (either order, which needs the grid
    // to have kept a publishable set).
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'alpha beta alpha' }, { body: 'alpha gamma' }]);

    const dlg = page.locator('views-dialog dialog');
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: '+ New visualization' }).click();
    await dlg.locator('input[type=text]').first().fill('Cloud');
    await dlg.locator('select').first().selectOption('wordcloud');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.locator('ul.list li', { hasText: 'Cloud' }).getByRole('button', { name: 'Use' }).click();
    await dlg.locator('select').first().selectOption('below');
    await dlg.getByRole('button', { name: 'Create view' }).click();
    await expect(dlg).toBeHidden();

    const cloud = page.locator(`#${panelDomId(id)} viz-pane viz-word-cloud`);
    await expect(cloud.locator('text').filter({ hasText: 'alpha' }).first()).toHaveText(/alpha/);

    await page.reload();
    await waitForPanel(page, id);
    const after = page.locator(`#${panelDomId(id)} viz-pane viz-word-cloud`);
    await expect(after).toBeVisible();
    // No resize, no click, no filter — the words must simply be there.
    await expect(after.locator('text').filter({ hasText: 'alpha' }).first()).toHaveText(/alpha/);
    await expect(after).not.toContainText('No words to show.');
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
