import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Docked panes sharing a ROW, side by side.
 *
 * Docking could only ever stack: `order` was the band a pane occupied, so three
 * charts above a grid were three full-width bands and the grid had nothing left.
 * A pane now carries a `row` as well, several panes can share one, and the row
 * divides its width between them.
 *
 * The moves are driven from the pane's own header strip, and they are pure
 * rewrites of the edge (`viz/viz-dock.ts`, unit-tested) — what this spec checks
 * is that the rewrite reaches the screen and survives a reload.
 */

const ROWS = [
  { country: 'CH', amount: 10 },
  { country: 'DE', amount: 5 },
  { country: 'AT', amount: 1 },
];

/** The pane wrappers of each row of the panel stack, top to bottom. */
async function rowShape(page: Page, tableId: string): Promise<number[]> {
  return page.locator(`#${panelDomId(tableId)} .panel-stack-row`).evaluateAll((rows) => rows.map((r) => r.querySelectorAll(':scope > .panel-stack-pane').length));
}

/** One pane's header button, by the label a screen reader would read. */
function paneButton(page: Page, tableId: string, name: string, label: string) {
  return page.locator(`#${panelDomId(tableId)} viz-pane`).filter({ hasText: name }).getByRole('button', { name: label, exact: true });
}

async function seed(page: Page): Promise<string> {
  const id = await createTable(page, 'Sales', [{ field: 'country' }, { field: 'amount', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, ROWS);
  return id;
}

/**
 * Dock `count` charts above the table, each on a row of its own.
 *
 * Through the Views dialog, which is the route a user has — and it is worth
 * going the long way round here, because "a new pane lands on a row of its own"
 * is part of what this spec is pinning down.
 */
async function dockCharts(page: Page, tableId: string, names: readonly string[], kind?: 'map'): Promise<void> {
  for (const name of names) {
    await page
      .locator(`#${panelDomId(tableId)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: '+ New visualization' }).click();
    await dlg.locator('input[type=text]').first().fill(name);
    if (kind) await dlg.locator('select').first().selectOption(kind);
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.locator('ul.list li', { hasText: name }).getByRole('button', { name: 'Use' }).click();
    await dlg.locator('select').first().selectOption('above');
    await dlg.getByRole('button', { name: 'Create view' }).click();
    // Modal: while it is up it owns the top layer, so a later click aimed at a
    // pane would land on the backdrop. Wait for it to be gone AND detached.
    await expect(dlg).toBeHidden();
    await expect(page.locator('views-dialog dialog[open]')).toHaveCount(0);
  }
}

test('a docked pane lands on a row of its own, as it always did', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await expect.poll(() => rowShape(page, id)).toEqual([1, 1]);
  // No width splitter anywhere: a row holding one pane has no boundary to drag.
  await expect(page.locator(`#${panelDomId(id)} .panel-stack-vsplitter`)).toHaveCount(0);
});

test('the first pane offers no moves, because it has nowhere to go', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await expect(paneButton(page, id, 'Beta', 'Join the row above')).toBeVisible();
  // Hidden rather than disabled: a permanently greyed arrow on a chart that can
  // never use it is noise in a strip that already holds six buttons.
  await expect(paneButton(page, id, 'Alpha', 'Join the row above')).toHaveCount(0);
  await expect(paneButton(page, id, 'Alpha', 'Move left')).toHaveCount(0);
});

test('joining the row above puts two panes side by side', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await paneButton(page, id, 'Beta', 'Join the row above').click();

  await expect.poll(() => rowShape(page, id)).toEqual([2]);
  // One boundary between them, and each takes half the row.
  await expect(page.locator(`#${panelDomId(id)} .panel-stack-vsplitter`)).toHaveCount(1);
  const widths = await page.locator(`#${panelDomId(id)} .panel-stack-row > .panel-stack-pane`).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(widths).toHaveLength(2);
  expect(Math.abs((widths[0] ?? 0) - (widths[1] ?? 0))).toBeLessThan(4);
});

test('the grid keeps its room when two charts share one row', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  const grid = page.locator(`#${panelDomId(id)} data-table`);
  const stacked = (await grid.boundingBox())?.height ?? 0;
  await paneButton(page, id, 'Beta', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);
  // Two bands became one, so the grid gets a band back — which is the reason
  // for the whole feature.
  await expect.poll(async () => (await grid.boundingBox())?.height ?? 0).toBeGreaterThan(stacked);
});

test('a pane can be given its own row again', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await paneButton(page, id, 'Beta', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);

  await paneButton(page, id, 'Beta', 'Give it its own row').click();
  await expect.poll(() => rowShape(page, id)).toEqual([1, 1]);
});

test('panes can be reordered within their row', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await paneButton(page, id, 'Beta', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);

  const labels = () => page.locator(`#${panelDomId(id)} .panel-stack-row > .panel-stack-pane viz-pane`).evaluateAll((els) => els.map((e) => (e as HTMLElement & { label: string }).label));
  await expect.poll(labels).toEqual([expect.stringContaining('Alpha'), expect.stringContaining('Beta')]);

  await paneButton(page, id, 'Beta', 'Move left').click();
  await expect.poll(labels).toEqual([expect.stringContaining('Beta'), expect.stringContaining('Alpha')]);
});

/**
 * Pixels actually painted on one pane's chart canvas.
 *
 * The `table.a11y` mirror the other specs assert on is Lit-rendered and would
 * still be there over a destroyed chart, so it cannot see this bug. A count of
 * non-transparent pixels can: Chart.js's `destroy()` leaves the canvas blank.
 */
async function chartInk(page: Page, tableId: string, name: string): Promise<number> {
  return page
    .locator(`#${panelDomId(tableId)} viz-pane`)
    .filter({ hasText: name })
    .locator('canvas')
    .evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (!ctx || canvas.width === 0 || canvas.height === 0) return 0;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let ink = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) ink++;
      return ink;
    });
}

const drawn = (page: Page, tableId: string, name: string) => expect.poll(() => chartInk(page, tableId, name), { timeout: 15_000 });

/**
 * A docked visualization survives the reflow that docking a NEIGHBOUR causes.
 *
 * This was a real bug, and it is the reason `child-plan.ts` exists. Rebuilding
 * an edge's rows re-appended every pane, a DOM move is a remove followed by an
 * insert, and `disconnectedCallback` on a chart destroys its Chart.js instance —
 * on a map, its Leaflet one. Nothing then asked for it back, because the panel
 * hands over the same data and the element compares it BY VALUE (which is what
 * stops a redraw mid-drag). So the pane beside the one you touched went blank
 * and stayed blank until a reload.
 */
test('a chart keeps its picture when a second pane is docked beside it', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha']);
  await drawn(page, id, 'Alpha').toBeGreaterThan(200);

  // Count every node the edge loses from here on. Alpha does not move — nothing
  // about its row changed — so the reflow should not detach anything at all, and
  // a redraw it never needed is a redraw the user sees as a flicker.
  await page.evaluate((sel) => {
    const host = document.querySelector(`${sel} .panel-stack-above`);
    const w = window as unknown as { __detached: number };
    w.__detached = 0;
    if (host) new MutationObserver((recs) => recs.forEach((r) => (w.__detached += r.removedNodes.length))).observe(host, { childList: true, subtree: true });
  }, `#${panelDomId(id)}`);

  await dockCharts(page, id, ['Beta']);
  await expect.poll(() => rowShape(page, id)).toEqual([1, 1]);
  await drawn(page, id, 'Alpha').toBeGreaterThan(200);
  await drawn(page, id, 'Beta').toBeGreaterThan(200);
  expect(await page.evaluate(() => (window as unknown as { __detached: number }).__detached)).toBe(0);
});

test('a chart that DOES change rows is redrawn rather than left blank', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await drawn(page, id, 'Beta').toBeGreaterThan(200);

  // Beta genuinely moves into another row here, so it is re-parented and its
  // chart really is destroyed. The redraw comes from its own reconnect.
  await paneButton(page, id, 'Beta', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);
  await drawn(page, id, 'Beta').toBeGreaterThan(200);
  await drawn(page, id, 'Alpha').toBeGreaterThan(200);
});

test('a chart keeps its picture when the pane beside it is closed', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await paneButton(page, id, 'Beta', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);
  await drawn(page, id, 'Alpha').toBeGreaterThan(200);

  await paneButton(page, id, 'Beta', 'Close').click();
  await expect.poll(() => rowShape(page, id)).toEqual([1]);
  await drawn(page, id, 'Alpha').toBeGreaterThan(200);
});

/**
 * The same bug as reported, on the visualization it was reported on.
 *
 * A map is the worst case and the one the user hit: Leaflet's `remove()` empties
 * the container, so the pane goes from a world to a grey rectangle. Markers are
 * the probe rather than tiles — tiles need the network, the points never do.
 */
const CITIES = [
  { city: 'Bern', lat: 46.948, lon: 7.4474 },
  { city: 'Zurich', lat: 47.3769, lon: 8.5417 },
  { city: 'Geneva', lat: 46.2044, lon: 6.1432 },
];

/** The circle markers Leaflet has actually drawn in the map pane. */
const markers = (page: Page, tableId: string) => page.locator(`#${panelDomId(tableId)} viz-point-map path.leaflet-interactive`);

test('a docked map keeps its points when another visualization is docked beside it', async ({ page }) => {
  const id = await createTable(page, 'Cities', [{ field: 'city' }, { field: 'lat', type: 'number' }, { field: 'lon', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, CITIES);
  await dockCharts(page, id, ['Places'], 'map');
  // Leaflet is lazily imported, so the markers are the thing to wait for.
  await expect(markers(page, id)).toHaveCount(3, { timeout: 20_000 });

  // The reported trigger: dock a second visualization. The map does not move.
  await dockCharts(page, id, ['Totals']);
  await expect.poll(() => rowShape(page, id)).toEqual([1, 1]);
  await expect(markers(page, id)).toHaveCount(3);

  // And the other half of the report: remove the one beside it again.
  await paneButton(page, id, 'Totals', 'Close').click();
  await expect.poll(() => rowShape(page, id)).toEqual([1]);
  await expect(markers(page, id)).toHaveCount(3);
});

test('a docked map redraws when it is the pane that moves', async ({ page }) => {
  const id = await createTable(page, 'Cities', [{ field: 'city' }, { field: 'lat', type: 'number' }, { field: 'lon', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, CITIES);
  await dockCharts(page, id, ['Totals']);
  await dockCharts(page, id, ['Places'], 'map');
  await expect(markers(page, id)).toHaveCount(3, { timeout: 20_000 });

  // Into the row above, which really does re-parent it and really does destroy
  // the Leaflet instance. It has to build itself a new one.
  await paneButton(page, id, 'Places', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);
  await expect(markers(page, id)).toHaveCount(3, { timeout: 20_000 });
});

test('a docked map comes back after a filter that matched nothing', async ({ page }) => {
  // Reported as "the map still craps out if I start filtering", and it is a
  // different bug from the docking one: `render()` only emits the container when
  // there are points, so a filter matching nothing makes Lit REMOVE the div the
  // Leaflet instance was built against. The instance then held an orphan node,
  // and every later draw added its markers to that — invisibly.
  const id = await createTable(page, 'Cities', [{ field: 'city' }, { field: 'lat', type: 'number' }, { field: 'lon', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, CITIES);
  await dockCharts(page, id, ['Places'], 'map');
  await expect(markers(page, id)).toHaveCount(3, { timeout: 20_000 });

  const filter = page.locator(`#${panelDomId(id)} data-table filter-combobox`).first().locator('input');
  // A narrowing filter is fine — the container survives, points > 0 throughout.
  await filter.fill('Bern');
  await expect(markers(page, id)).toHaveCount(1);

  // This is the one that broke it: nothing matches, so the container goes.
  await filter.fill('zzz');
  await expect(markers(page, id)).toHaveCount(0);
  await expect(page.locator(`#${panelDomId(id)} viz-point-map`)).toContainText('No points');

  // Back to the same three points as at the start — which is also the case the
  // value-comparison guard would wave through as "already drawn".
  await filter.fill('');
  await expect(markers(page, id)).toHaveCount(3, { timeout: 20_000 });

  // And it is a working map, not just markers: narrowing again still tracks.
  await filter.fill('Geneva');
  await expect(markers(page, id)).toHaveCount(1);
});

test('a shared row survives a reload', async ({ page }) => {
  const id = await seed(page);
  await dockCharts(page, id, ['Alpha', 'Beta']);
  await paneButton(page, id, 'Beta', 'Join the row above').click();
  await expect.poll(() => rowShape(page, id)).toEqual([2]);

  await page.reload();
  await waitForPanel(page, id);
  // The row is a stored fact about the dock, not a thing the session held.
  await expect.poll(() => rowShape(page, id), { timeout: 30_000 }).toEqual([2]);
});
