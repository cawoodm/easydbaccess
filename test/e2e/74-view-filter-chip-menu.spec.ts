import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A view's `$filter.TOKEN` pills OR-append: click `tag: red`, then `tag: blue`,
 * and the view shows both. But the first click hides every row that does not
 * carry `red` — including the ones whose pills would have offered `blue`. So the
 * other values were unreachable by clicking.
 *
 * A chip is now `field <op> value`, a button on each half, and it rides in the
 * view's ONE toolbar beside the sort controls instead of a second bar of its own:
 *  - the field (with its operator) cycles `=` → `≠` → off;
 *  - the value opens the field's other values as a tri-state CHECKLIST — the same
 *    popover the grid's funnel uses, so several values can be included or
 *    excluded in one visit.
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

const chips = (page: import('@playwright/test').Page) => page.locator('view-window .eda-pill-chip');
/** Chips that are actually filtering — an idle chip carries `.off`. */
const activeChips = (page: import('@playwright/test').Page) => page.locator('view-window .eda-pill-chip:not(.off)');
const idleChips = (page: import('@playwright/test').Page) => page.locator('view-window .eda-pill-chip.off');
/**
 * The tri-state value checklist — the grid's funnel popover. A native popover,
 * so a closed one is `display: none` and the visibility assertions below are
 * what distinguishes open from closed.
 */
const checklist = (page: import('@playwright/test').Page) => page.locator('filter-popover');
const option = (page: import('@playwright/test').Page, value: string) => checklist(page).locator('li', { hasText: value });

test('the chips ride in the same bar as the sort controls', async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');

  // No chips yet: the toolbar is the sort controls alone.
  await expect(vw.locator('.vw-sortbar')).toBeVisible();
  await expect(vw.locator('.vw-pillbar')).toHaveCount(0);

  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();

  // One bar holds both — the chip sits INSIDE the bar with the sort dropdown.
  const bar = vw.locator('.vw-sortbar');
  await expect(bar).toHaveCount(1);
  await expect(bar.locator('select[aria-label="Sort by"]')).toHaveCount(1);
  await expect(bar.locator('.eda-pill-chip')).toHaveCount(1);
  await expect(idleChips(page)).toHaveCount(0); // the field filters now, so no idle offer
  await expect(vw.locator('.vw-pillbar')).toHaveCount(0);
});

test('clicking the chip FIELD cycles = then ≠ then off', async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');
  const names = vw.locator('.nm');

  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();
  await expect(names).toHaveCount(2); // Bert + Dora
  await expect(chips(page).locator('.eda-pill-chip-field')).toHaveText(/tag =/);

  // = → ≠ : everything EXCEPT blue.
  await chips(page).locator('.eda-pill-chip-field').click();
  await expect(chips(page).locator('.eda-pill-chip-field')).toHaveText(/tag ≠/);
  await expect(names).toHaveCount(2); // Anna + Cleo
  await expect(vw.locator('.nm', { hasText: 'Anna' })).toHaveCount(1);
  await expect(vw.locator('.nm', { hasText: 'Bert' })).toHaveCount(0);

  // ≠ → off : every row is back, and the chip STAYS as the idle offer — before
  // this it vanished, taking the way back to the filter with it.
  await chips(page).locator('.eda-pill-chip-field').click();
  await expect(names).toHaveCount(4);
  await expect(activeChips(page)).toHaveCount(0);
  await expect(idleChips(page)).toHaveCount(1);
  await expect(idleChips(page)).toHaveText(/tag/);
});

/**
 * A `$filter.TOKEN` in the template is a filter the view OFFERS, so its chip is
 * in the toolbar from the start. Before this, the only way to reach the filter
 * was to find a row that happened to show the value and click its pill.
 */
test('a filter the template offers has an idle chip before anything is filtered', async ({ page }) => {
  await makeFilterView(page);

  await expect(idleChips(page)).toHaveCount(1);
  await expect(idleChips(page)).toHaveText(/tag/);
  // Idle: nothing to remove and no operator to cycle — the checklist and nothing else.
  await expect(idleChips(page).locator('.eda-pill-chip-remove')).toHaveCount(0);
  await expect(idleChips(page).locator('.eda-pill-chip-field')).toHaveCount(0);
  await expect(page.locator('view-window .nm')).toHaveCount(4); // nothing filtered
});

test('the idle chip opens the checklist, and picking a value filters', async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');

  await idleChips(page).locator('.eda-pill-chip-value').click();
  await expect(checklist(page)).toBeVisible();
  // Every value of the field, since nothing narrows it yet.
  await expect(option(page, 'red')).toHaveCount(1);
  await expect(option(page, 'blue')).toHaveCount(1);
  await expect(option(page, 'green')).toHaveCount(1);

  await option(page, 'blue').click();
  await expect(vw.locator('.nm')).toHaveCount(2); // Bert + Dora
  // The chip is active now, so the idle one for that field is gone.
  await expect(activeChips(page)).toHaveCount(1);
  await expect(idleChips(page)).toHaveCount(0);
});

test("clicking the chip VALUE opens a checklist of the field's other values", async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');

  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();
  await expect(vw.locator('.nm')).toHaveCount(2);

  await chips(page).locator('.eda-pill-chip-value').click();
  await expect(checklist(page)).toBeVisible();
  // Every tag is offered, not just the one filtered on.
  await expect(option(page, 'red')).toHaveCount(1);
  await expect(option(page, 'green')).toHaveCount(1);
  // The active one shows its include tick.
  await expect(option(page, 'blue').locator('.cb.on')).toHaveCount(1);

  // Ticking a second value applies live: blue OR red.
  await option(page, 'red').click();
  await expect(vw.locator('.nm')).toHaveCount(3);
  await expect(chips(page)).toHaveCount(2);
  await expect(vw.locator('.nm', { hasText: 'Cleo' })).toHaveCount(0);
});

test('the checklist is faceted by the OTHER fields still filtered', async ({ page }) => {
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

  await chips(page).filter({ hasText: 'blue' }).locator('.eda-pill-chip-value').click();
  await expect(checklist(page)).toBeVisible();
  await expect(option(page, 'blue')).toHaveCount(1);
  await expect(option(page, 'red')).toHaveCount(0);
  await expect(option(page, 'green')).toHaveCount(0);
});

test('the chip × still drops just that value', async ({ page }) => {
  await makeFilterView(page);
  const vw = page.locator('view-window');

  // The second value has to come from the checklist: once `blue` is filtered on,
  // the only pills left in the template are blue ones. That is the whole reason
  // the checklist exists.
  await vw.locator('.eda-filter-pill', { hasText: 'blue' }).first().click();
  await chips(page).locator('.eda-pill-chip-value').click();
  await option(page, 'green').click();
  await expect(chips(page)).toHaveCount(2);
  await page.keyboard.press('Escape');

  await chips(page).filter({ hasText: 'green' }).locator('.eda-pill-chip-remove').click();
  await expect(chips(page)).toHaveCount(1);
  await expect(vw.locator('.nm')).toHaveCount(2); // blue only
});
