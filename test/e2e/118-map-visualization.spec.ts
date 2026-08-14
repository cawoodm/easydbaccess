import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The map visualization actually drawing — which up to v0.0.372 it did not.
 *
 * Every layer was BUILT correctly: the tiles were in the DOM, the circle markers
 * were in the DOM, the point data was right. Leaflet's stylesheet went into
 * `document.head`, and the map lives inside `viz-panel`'s shadow root, where
 * document styles do not reach. So `.leaflet-pane { position: absolute }` never
 * applied and every pane, tile and marker stacked in normal flow — a map whose
 * markers were nowhere near it.
 *
 * That is why these assertions are about GEOMETRY rather than about elements
 * existing. "The markers exist" was true the whole time it was broken; "the
 * markers are inside the map" is the thing that was false.
 */

const CITIES = [
  { city: 'Bern', lat: 46.948, lon: 7.4474 },
  { city: 'Zurich', lat: 47.3769, lon: 8.5417 },
  { city: 'Geneva', lat: 46.2044, lon: 6.1432 },
];

async function seedCities(page: Page) {
  const id = await createTable(page, 'Cities', [{ field: 'city' }, { field: 'lat', type: 'number' }, { field: 'lon', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, CITIES);
  return id;
}

/** Create a map template and a view of it. `where` picks window vs. docked pane. */
async function makeMap(page: Page, tableId: string, where: 'window' | 'below' = 'window') {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '+ New visualization' }).click();
  await dlg.locator('input[type=text]').first().fill('Map');
  await dlg.locator('select').first().selectOption('map');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.locator('ul.list li', { hasText: 'Map' }).getByRole('button', { name: 'Use' }).click();
  if (where !== 'window') await dlg.locator('select').first().selectOption(where);
  await dlg.getByRole('button', { name: 'Create view' }).click();
  await expect(dlg).toBeHidden();
}

/**
 * What the map looks like to the browser, read through the shadow boundary.
 *
 * `viz-point-map` is inside `viz-panel`'s shadow root, so a plain
 * `document.querySelector` cannot see it — which is the same boundary the bug
 * was about.
 */
async function mapGeometry(page: Page) {
  return page.evaluate(() => {
    const deep = (root: Document | ShadowRoot, sel: string): Element | null => {
      const hit = root.querySelector(sel);
      if (hit) return hit;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const inner = deep(el.shadowRoot, sel);
          if (inner) return inner;
        }
      }
      return null;
    };
    const mapEl = deep(document, 'viz-point-map') as HTMLElement | null;
    if (!mapEl) return null;
    const container = mapEl.querySelector('.leaflet-container') as HTMLElement | null;
    const pane = mapEl.querySelector('.leaflet-pane') as HTMLElement | null;
    const box = container?.getBoundingClientRect();
    const within = (el: Element): boolean => {
      const b = el.getBoundingClientRect();
      if (!box || b.width === 0) return false;
      return b.top >= box.top - 1 && b.bottom <= box.bottom + 1 && b.left >= box.left - 1 && b.right <= box.right + 1;
    };
    const markers = [...mapEl.querySelectorAll('path.leaflet-interactive')];
    return {
      panePosition: pane ? getComputedStyle(pane).position : '(no pane)',
      height: Math.round(box?.height ?? 0),
      width: Math.round(box?.width ?? 0),
      markers: markers.length,
      markersInside: markers.filter(within).length,
      distinctMarkerTops: new Set(markers.map((m) => Math.round(m.getBoundingClientRect().top))).size,
    };
  });
}

test('a map plots its points inside the map, not stacked down the page', async ({ page }) => {
  const id = await seedCities(page);
  await makeMap(page, id);

  // Leaflet is lazily imported and the stylesheet with it, so wait for the
  // positioned pane rather than for a fixed delay.
  await expect.poll(async () => (await mapGeometry(page))?.panePosition, { timeout: 15_000 }).toBe('absolute');

  const geo = await mapGeometry(page);
  expect(geo).not.toBeNull();
  // The container fills the window it was given.
  expect(geo!.height).toBeGreaterThan(100);
  expect(geo!.width).toBeGreaterThan(100);
  // One marker per city, and every one of them ON the map. This is the assertion
  // that failed: unstyled, all three sat outside the container entirely.
  expect(geo!.markers).toBe(CITIES.length);
  expect(geo!.markersInside).toBe(CITIES.length);
  // Three cities at three latitudes are three different heights on screen. In
  // normal flow they would have been evenly stacked instead — a different bug
  // with the same marker count, so the count alone cannot catch it.
  expect(geo!.distinctMarkerTops).toBeGreaterThan(1);
});

test('a map docked under a grid draws the same way', async ({ page }) => {
  // A pane is a second shadow root (`viz-pane` → `viz-panel`), so it is a
  // separate chance for the stylesheet not to arrive.
  const id = await seedCities(page);
  await makeMap(page, id, 'below');

  await expect.poll(async () => (await mapGeometry(page))?.panePosition, { timeout: 15_000 }).toBe('absolute');
  const geo = await mapGeometry(page);
  expect(geo!.markersInside).toBe(CITIES.length);
  expect(geo!.height).toBeGreaterThan(50);
});

test('a map of one point still centres on it', async ({ page }) => {
  // `fitBounds` on a single point is a degenerate box; Leaflet handles it, but a
  // maxZoom mistake here shows up as a marker off-container rather than an error.
  const id = await createTable(page, 'One', [{ field: 'city' }, { field: 'lat', type: 'number' }, { field: 'lon', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ city: 'Bern', lat: 46.948, lon: 7.4474 }]);
  await makeMap(page, id);

  await expect.poll(async () => (await mapGeometry(page))?.panePosition, { timeout: 15_000 }).toBe('absolute');
  const geo = await mapGeometry(page);
  expect(geo!.markers).toBe(1);
  expect(geo!.markersInside).toBe(1);
});

/** Where the first marker sits horizontally, once it has stopped moving. */
async function settledMarkerLeft(page: Page): Promise<number> {
  const read = () => page.locator('viz-point-map path.leaflet-interactive').first().evaluate((el) => Math.round(el.getBoundingClientRect().left));
  let last = await read();
  // Leaflet animates zoom and eases a drag, so a reading taken mid-flight is not
  // a baseline. Wait for two identical samples rather than for a fixed delay.
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(100);
    const now = await read();
    if (now === last) return now;
    last = now;
  }
  return last;
}

test('the zoom control zooms the map', async ({ page }) => {
  // "Unusable" was the other half of the report: unstyled, the control sat in
  // normal flow, so it was not where it looked like it was.
  const id = await seedCities(page);
  await makeMap(page, id);
  await expect.poll(async () => (await mapGeometry(page))?.panePosition, { timeout: 15_000 }).toBe('absolute');

  // The zoom is legible from the tile URLs Leaflet asked for: `/{z}/{x}/{y}.png`.
  const zoomOf = () =>
    page.locator('viz-point-map img.leaflet-tile').first().evaluate((el) => {
      const m = (el as HTMLImageElement).src.match(/\/(\d+)\/\d+\/\d+\.png/);
      return m ? Number(m[1]) : null;
    });

  const before = await zoomOf();
  expect(before).not.toBeNull();
  await page.locator('viz-point-map .leaflet-control-zoom-in').click();
  await expect.poll(zoomOf, { timeout: 10_000 }).toBe((before ?? 0) + 1);
});

test('dragging pans the map', async ({ page }) => {
  // Its own test rather than a second half of the zoom one: a zoom animation
  // still settling moves the markers, which made a baseline taken right after it
  // meaningless and the assertion flaky.
  const id = await seedCities(page);
  await makeMap(page, id);
  await expect.poll(async () => (await mapGeometry(page))?.panePosition, { timeout: 15_000 }).toBe('absolute');

  const before = await settledMarkerLeft(page);
  const box = (await page.locator('viz-point-map .leaflet-container').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // Several steps, the first already past Leaflet's 3px drag threshold.
  for (const dx of [10, 30, 50, 70, 90]) await page.mouse.move(cx - dx, cy);
  await page.mouse.up();

  // Dragged 90px left, so every point travels left with the map. The slack is for
  // the easing Leaflet applies after the pointer is released.
  expect(await settledMarkerLeft(page)).toBeLessThan(before - 40);
});

test('“Size by” gives the markers visibly different radii', async ({ page }) => {
  // Reported as "Size by not working", and it effectively did not: the radius was
  // `markerSize * sqrt(w / maxWeight)`, so on real data (a 1.9 MW plant against a
  // 6000 MW one) everything but the largest collapsed onto the 2px floor and the
  // largest kept the unscaled size. Identical dots, whatever the column said.
  const id = await createTable(page, 'Plants', [
    { field: 'name' },
    { field: 'lat', type: 'number' },
    { field: 'lon', type: 'number' },
    { field: 'capacity_mw', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'tiny', lat: 46.9, lon: 7.4, capacity_mw: 1.9 },
    { name: 'middling', lat: 47.4, lon: 8.5, capacity_mw: 100 },
    { name: 'huge', lat: 46.2, lon: 6.1, capacity_mw: 6000 },
  ]);

  // Map the WEIGHT channel and switch scaling on, through the store — the point
  // here is the drawing, and the mapping form has its own coverage.
  await makeMap(page, id);
  await expect.poll(async () => (await mapGeometry(page))?.panePosition, { timeout: 15_000 }).toBe('absolute');

  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const insts = (await store.viewInstances.find()) as any[];
    const inst = insts[0];
    await store.viewInstances.patch(inst.id, {
      mapping: { ...inst.mapping, WEIGHT: 'capacity_mw' },
      vizOptions: { ...(inst.vizOptions ?? {}), scaleByWeight: true },
      updatedAt: Date.now(),
    });
    document.dispatchEvent(new CustomEvent('easydb:reload-view', { detail: { instanceId: inst.id } }));
  });

  /** Each marker's drawn radius, smallest first. */
  const radii = () =>
    page.evaluate(() => {
      const deep = (root: Document | ShadowRoot): Element | null => {
        const hit = root.querySelector('viz-point-map');
        if (hit) return hit;
        for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { const i = deep(el.shadowRoot); if (i) return i; }
        return null;
      };
      const el = deep(document);
      return [...(el?.querySelectorAll('path.leaflet-interactive') ?? [])].map((m) => Math.round(m.getBoundingClientRect().width / 2)).sort((a, b) => a - b);
    });

  await expect.poll(radii, { timeout: 15_000 }).toHaveLength(3);
  const [small, mid, big] = await radii();
  // Three distinct sizes, in order — and the biggest bigger than the 6px default,
  // because scaling has to grow markers as well as shrink them.
  expect(small!).toBeLessThan(mid!);
  expect(mid!).toBeLessThan(big!);
  expect(big!).toBeGreaterThan(6);
});
