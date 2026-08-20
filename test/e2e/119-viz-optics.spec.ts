import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A visualization redraws for DATA, not for optics.
 *
 * Reported as "word cloud and visualisations should not be triggered for update
 * just because I resize columns". Everything the grid does goes through
 * `updated()`, and a column width is `@state` — so one resize drag published the
 * row set once per pointermove and then persisted a `width` onto every
 * ColumnSpec, and a docked pane took both as news.
 *
 * **The map is what these tests assert on**, because its redraw is not merely
 * wasted work: `draw()` ends in `fitBounds`, so redrawing throws away wherever
 * the user had panned and zoomed to. That is a visible, measurable symptom of the
 * exact behaviour being fixed. The word cloud suffers the same needless
 * re-layout, but d3-cloud is deterministic for a given box, so a spurious
 * re-layout leaves the words in the same places and there is nothing to catch
 * from outside — its guard is covered by unit tests instead
 * (`test/renderer/viz/same-input.test.ts`).
 *
 * The two tests are two different code paths, both of which had to be fixed:
 * a DOCKED pane is fed by the grid (`table/visible-rows.ts`), and a WINDOWED one
 * reads for itself but watches the `tables` collection, which is what a persisted
 * width is written to.
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

/** Leaflet is lazily imported; wait for the positioned pane rather than a delay. */
async function waitForMap(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const deep = (root: Document | ShadowRoot): Element | null => {
            const hit = root.querySelector('viz-point-map .leaflet-pane');
            if (hit) return hit;
            for (const el of root.querySelectorAll('*')) {
              if (el.shadowRoot) {
                const inner = deep(el.shadowRoot);
                if (inner) return inner;
              }
            }
            return null;
          };
          const pane = deep(document);
          return pane ? getComputedStyle(pane).position : null;
        }),
      { timeout: 15_000 },
    )
    .toBe('absolute');
}

interface MarkerSpot {
  /** Marker position RELATIVE to the map container, so moving the panel is not a move. */
  left: number;
  top: number;
  /** The container's own size, asserted unchanged — see the tests. */
  w: number;
  h: number;
}

/** Where the first marker sits inside the map, right now. */
function readMarker(page: Page): Promise<MarkerSpot> {
  return page
    .locator('viz-point-map .leaflet-container')
    .first()
    .evaluate((box) => {
      const marker = box.querySelector('path.leaflet-interactive');
      const b = box.getBoundingClientRect();
      const m = marker?.getBoundingClientRect();
      return {
        left: Math.round((m?.left ?? 0) - b.left),
        top: Math.round((m?.top ?? 0) - b.top),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    });
}

/** Where the first marker sits once it has stopped moving. */
async function settledMarker(page: Page): Promise<MarkerSpot> {
  let last = await readMarker(page);
  let still = 0;
  // Leaflet eases a drag and animates a zoom, so a single reading mid-flight is
  // not an answer. THREE identical samples, not two: a drag's inertia decelerates,
  // so two consecutive readings can agree while it is still moving.
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(100);
    const now = await readMarker(page);
    still = now.left === last.left && now.top === last.top ? still + 1 : 0;
    last = now;
    if (still >= 2) return now;
  }
  return last;
}

/**
 * Drag the map left and return where the marker came to rest.
 *
 * The wait for it to have MOVED is not belt-and-braces: Leaflet applies the pan
 * on an animation frame and then decelerates, so for the first ~100ms after
 * mouseup the marker is still exactly where it started. Settling alone would
 * happily park on that plateau and hand back the PRE-pan position as the
 * baseline — which then differs from the real one by the width of the drag, and
 * the test fails claiming the map was re-fitted when it never moved.
 */
async function panMapLeftAndPark(page: Page): Promise<MarkerSpot> {
  const before = await settledMarker(page);
  const box = (await page.locator('viz-point-map .leaflet-container').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  // The first step is already past Leaflet's 3px drag threshold.
  for (const dx of [10, 40, 70, 100, 130]) await page.mouse.move(cx - dx, cy);
  await page.mouse.up();
  await expect.poll(async () => (await readMarker(page)).left, { timeout: 10_000 }).toBeLessThan(before.left - 40);
  return settledMarker(page);
}

/** Drag the first grid column's right-hand gutter +120px. Pure optics. */
async function resizeFirstColumn(page: Page, tableId: string): Promise<void> {
  const th = page.locator(`#${panelDomId(tableId)} data-table th`).first();
  await expect(th).toBeVisible();
  const before = (await th.boundingBox())!.width;
  const handle = th.locator('.col-resize');
  const hb = (await handle.boundingBox())!;
  const x = hb.x + hb.width / 2;
  const y = hb.y + hb.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Several steps, because the bug was per POINTERMOVE — one big jump would
  // under-test it.
  for (const dx of [20, 45, 70, 95, 120]) await page.mouse.move(x + dx, y);
  await page.mouse.up();
  // The drag really moved the column, so a passing assertion below cannot be a
  // resize that never happened.
  await expect.poll(async () => (await th.boundingBox())!.width, { timeout: 5000 }).toBeGreaterThan(before + 80);
}

test('resizing a grid column leaves a docked map where the user put it', async ({ page }) => {
  const id = await seedCities(page);
  await makeMap(page, id, 'below');
  await waitForMap(page);

  const parked = await panMapLeftAndPark(page);

  await resizeFirstColumn(page, id);

  // Unchanged: the grid republished an identical row set per pointermove, and each
  // publish redrew the map — which re-fits the bounds and snaps back here.
  const after = await settledMarker(page);
  // The map box itself did not change, so a marker that moved inside it can only
  // have been re-fitted.
  expect({ w: after.w, h: after.h }).toEqual({ w: parked.w, h: parked.h });
  expect(Math.abs(after.left - parked.left)).toBeLessThan(4);
  expect(Math.abs(after.top - parked.top)).toBeLessThan(4);
});

test('resizing a grid column leaves a map in its own window alone', async ({ page }) => {
  // The other path: a windowed visualization reads rows itself, so the grid never
  // publishes to it — but it watches the `tables` collection for renames and
  // scripts, and dropping the drag persists a `width` on every ColumnSpec there.
  const id = await seedCities(page);
  await makeMap(page, id, 'window');
  await waitForMap(page);

  const parked = await panMapLeftAndPark(page);

  await resizeFirstColumn(page, id);

  const after = await settledMarker(page);
  // The map box itself did not change, so a marker that moved inside it can only
  // have been re-fitted.
  expect({ w: after.w, h: after.h }).toEqual({ w: parked.w, h: parked.h });
  expect(Math.abs(after.left - parked.left)).toBeLessThan(4);
  expect(Math.abs(after.top - parked.top)).toBeLessThan(4);
});

test('a real data change still redraws the docked map', async ({ page }) => {
  // The other half of the contract, and the thing a too-eager guard would break:
  // suppressing an optics-only redraw must not suppress a data one. Filtering the
  // grid is the two-way street working — the pane draws what the grid shows.
  const id = await seedCities(page);
  await makeMap(page, id, 'below');
  await waitForMap(page);

  const markers = () => page.locator('viz-point-map path.leaflet-interactive');
  await expect(markers()).toHaveCount(CITIES.length);

  await page
    .locator(`#${panelDomId(id)} data-table tr.filter-row filter-combobox input`)
    .first()
    .fill('Bern');

  await expect(markers()).toHaveCount(1);
});
