import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A maximized window must fill the whole table area (the #easydb-panels box)
 * and STAY filling it as the pan/zoom canvas is panned or zoomed underneath.
 *
 * Panels live inside the transformed viewport, so jsPanel's maximize (which
 * sizes to the viewport's layout box) would otherwise be offset/scaled by the
 * canvas transform. The window manager counters the canvas transform on the
 * maximized panel and keeps it in sync on every pan/zoom, so it stays pinned
 * to the visible area.
 */

// Dispatch a synthetic touch gesture on the canvas overlay. `moves` are the
// per-touch end coordinates matching `starts` by index; equal deltas across two
// touches pan (pure translate), unequal deltas pinch (zoom).
async function gesture(
  page: import('@playwright/test').Page,
  starts: Array<[number, number]>,
  moves: Array<[number, number]>,
) {
  await page.evaluate(
    ([starts, moves]) => {
      const outer = document.getElementById('easydb-panels') as HTMLElement;
      const touch = (idn: number, x: number, y: number) =>
        new Touch({ identifier: idn, target: outer, clientX: x, clientY: y });
      const fire = (type: string, ts: Touch[]) =>
        outer.dispatchEvent(
          new TouchEvent(type, {
            touches: ts,
            changedTouches: ts,
            bubbles: true,
            cancelable: true,
          }),
        );
      fire(
        'touchstart',
        starts.map(([x, y], i) => touch(i + 1, x, y)),
      );
      fire(
        'touchmove',
        moves.map(([x, y], i) => touch(i + 1, x, y)),
      );
      fire('touchend', []);
    },
    [starts, moves] as const,
  );
}

async function fillsOverlay(page: import('@playwright/test').Page, panelSel: string) {
  const outer = (await page.locator('#easydb-panels').boundingBox())!;
  const panel = (await page.locator(panelSel).boundingBox())!;
  return {
    dx: Math.abs(panel.x - outer.x),
    dy: Math.abs(panel.y - outer.y),
    dw: Math.abs(panel.width - outer.width),
    dh: Math.abs(panel.height - outer.height),
  };
}

test('maximized window stays filling the area through pan and zoom', async ({ page }) => {
  const id = await createTable(page, 'Max', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const panelSel = `#${panelDomId(id)}`;
  const panel = page.locator(panelSel);

  // Pan the canvas first so maximizing must account for a non-identity view.
  await gesture(
    page,
    [
      [100, 100],
      [300, 300],
    ],
    [
      [150, 150],
      [350, 350],
    ],
  );

  await panel.locator('.jsPanel-btn-maximize').click();
  await page.waitForTimeout(120);

  // Fills the whole area right after maximizing.
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dx).toBeLessThan(4);
    expect(d.dy).toBeLessThan(4);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }

  // Pan the canvas again WHILE maximized (equal two-finger delta = translate) →
  // still fills.
  await gesture(
    page,
    [
      [120, 120],
      [320, 320],
    ],
    [
      [220, 260],
      [420, 460],
    ],
  );
  await page.waitForTimeout(80);
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dx).toBeLessThan(4);
    expect(d.dy).toBeLessThan(4);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }

  // Pinch-zoom the canvas WHILE maximized (two-finger spread = scale) → still
  // fills. This exercises the counter transform at scale ≠ 1.
  await gesture(
    page,
    [
      [200, 200],
      [260, 260],
    ],
    [
      [140, 140],
      [360, 360],
    ],
  );
  await page.waitForTimeout(80);
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dx).toBeLessThan(4);
    expect(d.dy).toBeLessThan(4);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }

  // Un-maximize → the panel returns to a normal (smaller) size, no longer
  // covering the whole area, and its counter transform is cleared.
  await panel.locator('.jsPanel-btn-normalize').click();
  await page.waitForTimeout(120);
  // Compare LAYOUT sizes (offsetWidth) — the visual boundingBox is inflated by
  // the zoomed canvas transform and wouldn't reflect the panel's real size.
  const viewportW = await page.evaluate(
    () => document.getElementById('easydb-panels-viewport')!.clientWidth,
  );
  const panelW = await panel.evaluate((el) => (el as HTMLElement).offsetWidth);
  expect(panelW).toBeLessThan(viewportW - 50);
  // The counter transform is cleared, so the panel rides the canvas normally again.
  expect(await panel.evaluate((el) => (el as HTMLElement).style.transform)).toBe('');
});

test('a maximized grid fills the content box — no dead gap above the footer', async ({ page }) => {
  const id = await createTable(page, 'Tall', [{ field: 'a' }]);
  await waitForPanel(page, id);
  // Enough rows that the grid wants to be taller than the panel either way, so
  // any shortfall is the host's own height cap rather than a lack of content.
  await bulkAddRows(
    page,
    id,
    Array.from({ length: 120 }, (_, i) => ({ a: `row ${i + 1}` })),
  );
  const panelSel = `#${panelDomId(id)}`;
  await page.locator(panelSel).locator('.jsPanel-btn-maximize').click();
  await page.waitForTimeout(200);

  // The grid must be exactly as tall as the content box it sits in. A hard
  // `max-height: 60vh` on <data-table> used to beat the inline height:100%,
  // leaving a large empty strip between the last row and the panel footer.
  const { contentH, gridH } = await page.locator(panelSel).evaluate((el) => {
    const content = el.querySelector('.jsPanel-content') as HTMLElement;
    const grid = el.querySelector('data-table') as HTMLElement;
    return {
      contentH: content.getBoundingClientRect().height,
      gridH: grid.getBoundingClientRect().height,
    };
  });
  expect(Math.abs(contentH - gridH)).toBeLessThan(2);
  expect(gridH).toBeGreaterThan(300); // sanity: it really is a tall panel

  // And the grid scrolls internally rather than pushing the panel open.
  const scrolls = await page
    .locator(`${panelSel} data-table`)
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls).toBe(true);
});

test('double-clicking the titlebar maximizes, and again restores', async ({ page }) => {
  const id = await createTable(page, 'Dbl', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const panelSel = `#${panelDomId(id)}`;
  const panel = page.locator(panelSel);
  const status = () => panel.evaluate((el) => (el as HTMLElement & { status: string }).status);
  const title = panel.locator('.jsPanel-title');

  const titlebarCursor = () =>
    panel
      .locator('.jsPanel-titlebar')
      .evaluate((el) => getComputedStyle(el as HTMLElement).cursor);

  expect(await status()).toBe('normalized');
  // Draggable ⇒ the move cursor is honest.
  expect(await titlebarCursor()).toBe('move');

  await title.dblclick();
  await page.waitForTimeout(200);
  expect(await status()).toBe('maximized');
  {
    const d = await fillsOverlay(page, panelSel);
    expect(d.dw).toBeLessThan(4);
    expect(d.dh).toBeLessThan(4);
  }
  // jsPanel's dragit.disableOnMaximized default blocks dragging while
  // maximized, so `move` would advertise something that cannot happen. The
  // titlebar's real affordance here is the double-click that restores it.
  expect(await titlebarCursor()).toBe('pointer');

  await title.dblclick();
  await page.waitForTimeout(200);
  expect(await status()).toBe('normalized');
  expect(await titlebarCursor()).toBe('move');

  // A double-click inside the titlebar's search box selects a word — it must NOT
  // toggle the window.
  const search = panel.locator('panel-search input');
  if (await search.count()) {
    await search.dblclick();
    await page.waitForTimeout(150);
    expect(await status()).toBe('normalized');
  }
});

test('maximized windows re-fit when the browser window is resized', async ({ page }) => {
  const idA = await createTable(page, 'MaxA', [{ field: 'a' }]);
  await waitForPanel(page, idA);
  const idB = await createTable(page, 'MaxB', [{ field: 'b' }]);
  await waitForPanel(page, idB);

  const selA = `#${panelDomId(idA)}`;
  const selB = `#${panelDomId(idB)}`;
  // Maximize both via the panel API, not the titlebar button: the first
  // maximized panel covers the second one's button, so a click would be
  // intercepted. The click path is covered by the pan/zoom test above.
  for (const sel of [selA, selB]) {
    await page
      .locator(sel)
      .evaluate((el) => (el as HTMLElement & { maximize(): void }).maximize());
  }
  await page.waitForTimeout(150);

  // jsPanel sizes a maximized panel ONCE from its container, and its own
  // onwindowresize option is inert for a non-'window' container — so without an
  // explicit re-fit these panels keep their old box and overflow the new one.
  for (const size of [
    { width: 820, height: 600 },
    { width: 1280, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.waitForTimeout(200);
    for (const sel of [selA, selB]) {
      const d = await fillsOverlay(page, sel);
      expect(d.dx).toBeLessThan(4);
      expect(d.dy).toBeLessThan(4);
      expect(d.dw).toBeLessThan(4);
      expect(d.dh).toBeLessThan(4);
    }
  }

  // The restore size must survive the resizes — a re-fit must not overwrite the
  // panel's remembered normal geometry with the maximized one.
  await page
    .locator(selA)
    .evaluate((el) => (el as HTMLElement & { normalize(): void }).normalize());
  await page.waitForTimeout(150);
  const viewportW = await page.evaluate(
    () => document.getElementById('easydb-panels-viewport')!.clientWidth,
  );
  const panelW = await page.locator(selA).evaluate((el) => (el as HTMLElement).offsetWidth);
  expect(panelW).toBeLessThan(viewportW - 50);
});
