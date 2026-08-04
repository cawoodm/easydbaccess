import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A pointerdown inside a panel fronts it only when another VISIBLE panel is on
 * top. A minimized panel keeps the z-index it went down with while being
 * `display:none`, so it used to count: every click on the panel the user was
 * actually working in fronted it, and a front writes the front order to the
 * store — the churn the topmost check exists to avoid.
 */

const zOf = (page: import('@playwright/test').Page, tableId: string) => page.locator(`#${panelDomId(tableId)}`).evaluate((el) => Number(el.style.zIndex));

/** Straight to the element, so an overlapping neighbour cannot take the click. */
const poke = (page: import('@playwright/test').Page, tableId: string) =>
  page
    .locator(`#${panelDomId(tableId)}`)
    .locator('.jsPanel-titlebar')
    .dispatchEvent('pointerdown');

test('a minimized panel above does not make every click a front', async ({ page }) => {
  const under = await createTable(page, 'Under', [{ field: 'x' }]);
  await waitForPanel(page, under);
  const over = await createTable(page, 'Over', [{ field: 'x' }]);
  await waitForPanel(page, over);
  // The newer panel opens above the older one.
  expect(await zOf(page, over)).toBeGreaterThan(await zOf(page, under));

  await page
    .locator(`#${panelDomId(over)}`)
    .locator('button[title="Minimize"]')
    .click();
  await expect(page.locator(`#${panelDomId(over)}`)).toBeHidden();

  const before = await zOf(page, under);
  await poke(page, under);
  // Fronting is synchronous in the pointerdown handler, so this reads the result.
  expect(await zOf(page, under)).toBe(before);
});

test('a VISIBLE panel above still fronts the one that is clicked', async ({ page }) => {
  // The other half of the rule — the check must not stop fronting altogether.
  const under = await createTable(page, 'Under2', [{ field: 'x' }]);
  await waitForPanel(page, under);
  const over = await createTable(page, 'Over2', [{ field: 'x' }]);
  await waitForPanel(page, over);

  const before = await zOf(page, under);
  await poke(page, under);
  expect(await zOf(page, under)).toBeGreaterThan(before);
  expect(await zOf(page, under)).toBeGreaterThan(await zOf(page, over));
});
