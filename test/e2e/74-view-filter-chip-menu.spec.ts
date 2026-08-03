import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A view's `$filter.TOKEN` pills OR-append: click `tag: red`, then `tag: blue`,
 * and the view shows both. But the first click hides every row that does not
 * carry `red` — including the ones whose pills would have offered `blue`. So the
 * second value was unreachable by clicking.
 *
 * The active filter's chip now opens the field's value list (the same faceted
 * list the table's column filter offers), with a tick on what is already
 * filtered on. Picking a value ORs it in; picking a ticked one drops it.
 */

const ROWS = [
  { name: 'Anna', tag: 'red' },
  { name: 'Bert', tag: 'blue' },
  { name: 'Cleo', tag: 'green' },
  { name: 'Dora', tag: 'blue' },
];

/** A view whose row template shows the name and a clickable tag pill. */
async function makeFilterView(page: import('@playwright/test').Page): Promise<string> {
  const tableId = await createTable(page, 'Tagged', [{ field: 'name' }, { field: 'tag' }]);
  await waitForPanel(page, tableId);
  await bulkAddRows(page, tableId, ROWS);

  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const tpl = {
      id: crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      name: 'Tag pills',
      headerHtml: '',
      rowHtml: '<div class="card"><span class="nm">$NAME</span> $filter.TAG</div>',
      footerHtml: '',
      updatedAt: Date.now(),
    };
    await ctx.store.viewTemplates.insert(tpl);
    await ctx.store.viewInstances.insert({
      id: crypto.randomUUID(),
      workspaceId: ctx.workspaceId,
      tableId: tid,
      templateId: tpl.id,
      name: 'Tags',
      mapping: { NAME: 'name', TAG: 'tag' },
      visibleColumns: ['name', 'tag'],
      filters: {},
      open: true,
      updatedAt: Date.now(),
    });
  }, tableId);

  await expect(page.locator('view-window')).toBeVisible();
  return tableId;
}

const chip = (page: import('@playwright/test').Page) =>
  page.locator('view-window .eda-pill-chip');
const menuItems = (page: import('@playwright/test').Page) =>
  page.locator('anchored-menu button[role="menuitem"], anchored-menu .menu button');

test('the chip offers the field\'s other values, and a pick ORs it in', async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');

  // Filter to `blue` by clicking one row's pill.
  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();
  await expect(vw.locator('.nm')).toHaveCount(2); // Bert + Dora
  await expect(chip(page)).toHaveText(/tag: blue/);

  // The chip lists every tag — not just the filtered one.
  await chip(page).locator('.eda-pill-chip-label').click();
  await expect(menuItems(page)).toHaveCount(3);
  await expect(menuItems(page).filter({ hasText: 'red' })).toBeVisible();
  await expect(menuItems(page).filter({ hasText: 'green' })).toBeVisible();

  await menuItems(page).filter({ hasText: 'red' }).click();

  // blue OR red — Anna joins Bert and Dora, and each value has its own chip.
  await expect(vw.locator('.nm')).toHaveCount(3);
  await expect(chip(page)).toHaveCount(2);
  await expect(vw.locator('.nm', { hasText: 'Cleo' })).toHaveCount(0);
});

test('picking a value that is already filtered on removes it', async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');

  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();
  await expect(chip(page)).toHaveCount(1);

  await chip(page).locator('.eda-pill-chip-label').click();
  // The active value is ticked, which is what makes it a toggle.
  const active = menuItems(page).filter({ hasText: 'blue' });
  await expect(active.locator('.mi')).toHaveText('check');
  await active.click();

  // No pill filter left: every row is back.
  await expect(chip(page)).toHaveCount(0);
  await expect(vw.locator('.nm')).toHaveCount(4);
});

test('the value list is faceted by the OTHER fields still filtered', async ({ page }) => {
  // `name` is pill-filtered to Bert, so the tag chip must offer only Bert's tag —
  // the list narrows with the rest of the filters, exactly like the grid's.
  await makeFilterView(page);
  const vw = page.locator('view-window');

  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const inst = (await ctx.store.viewInstances.find({ workspaceId: ctx.workspaceId }))[0];
    await ctx.store.viewInstances.patch(inst.id, {
      pillFilters: { ...(inst.pillFilters ?? {}), name: '=Bert' },
      updatedAt: Date.now(),
    });
  });
  await expect(vw.locator('.nm')).toHaveCount(1);

  await chip(page).filter({ hasText: 'tag: blue' }).locator('.eda-pill-chip-label').click();
  await expect(menuItems(page)).toHaveCount(1);
  await expect(menuItems(page).first()).toContainText('blue');
});
