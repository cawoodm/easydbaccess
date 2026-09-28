import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A `$filter.TAGS` token over an `array` column: the cell holds several values,
 * so it renders several chips — one per member — and clicking one filters on
 * that member alone.
 *
 * It used to render ONE chip carrying the whole cell (`red,blue`), and clicking
 * it filtered on `=red,blue`. No list cell is ever exactly equal to that, so the
 * view emptied itself on the click.
 */

const ROWS = [
  { name: 'Anna', tags: 'red,blue' },
  { name: 'Bert', tags: 'blue' },
  { name: 'Cleo', tags: '["green","red"]' },
  { name: 'Dora', tags: '' },
];

/** A view over an `array` column whose row template shows name + tag chips. */
async function makeArrayPillView(page: import('@playwright/test').Page): Promise<string> {
  const tableId = await createTable(page, 'Tagged', [{ field: 'name' }, { field: 'tags', type: 'array' }]);
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
      rowHtml: '<div class="card"><span class="nm">$NAME</span> $filter.TAGS</div>',
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
      mapping: { NAME: 'name', TAGS: 'tags' },
      visibleColumns: ['name', 'tags'],
      filters: {},
      open: true,
      updatedAt: Date.now(),
    });
  }, tableId);

  await expect(page.locator('view-window')).toBeVisible();
  return tableId;
}

const cards = (page: import('@playwright/test').Page) => page.locator('view-window .card');
/**
 * The names the view shows, sorted. NOT in document order: the store hands back
 * the rows it holds in whatever order it reads them, and this view sets no sort,
 * so which card comes first is not something the filtering promises.
 */
const shownNames = async (page: import('@playwright/test').Page) => (await page.locator('view-window .nm').allTextContents()).sort();
// A body chip (see `pill-chip.ts`) is the VALUE alone — one wrapper span
// around one button. This returns the wrapper for one member; `.eda-pill-chip-value`
// both reads its text and is what a click has to target to apply the filter.
const pillsOf = (page: import('@playwright/test').Page, name: string) => page.locator('view-window .card', { hasText: name }).locator('.eda-pill-chip');

test('a list cell renders one chip per member', async ({ page }) => {
  await makeArrayPillView(page);

  await expect(pillsOf(page, 'Anna').locator('.eda-pill-chip-value')).toHaveText(['red', 'blue']);
  await expect(pillsOf(page, 'Bert').locator('.eda-pill-chip-value')).toHaveText(['blue']);
  // JSON-array spelling reads the same way.
  await expect(pillsOf(page, 'Cleo').locator('.eda-pill-chip-value')).toHaveText(['green', 'red']);
  // An empty list gets no chip, exactly as an empty cell never did.
  await expect(pillsOf(page, 'Dora')).toHaveCount(0);
});

test('clicking one member keeps every row carrying it', async ({ page }) => {
  await makeArrayPillView(page);
  await expect(cards(page)).toHaveCount(4);

  await pillsOf(page, 'Anna').filter({ hasText: 'red' }).locator('.eda-pill-chip-value').click();

  // Anna (red,blue) and Cleo (green,red) carry red; Bert and Dora do not.
  await expect(cards(page)).toHaveCount(2);
  expect(await shownNames(page)).toEqual(['Anna', 'Cleo']);

  // The chip in the toolbar names the member, not the whole cell. Scoped to
  // the sortbar: the surviving cards (Anna, Cleo) still draw their OWN body
  // chips for every member they carry, which share these same classes.
  await expect(page.locator('view-window .vw-sortbar .eda-pill-chip')).toHaveCount(1);
  await expect(page.locator('view-window .vw-sortbar .eda-pill-chip-value')).toHaveText('red');
});

test('a second member ORs onto the first', async ({ page }) => {
  await makeArrayPillView(page);
  await pillsOf(page, 'Anna').filter({ hasText: 'red' }).locator('.eda-pill-chip-value').click();
  await expect(cards(page)).toHaveCount(2);

  // Anna still shows both her chips, so the sibling value stays reachable.
  await pillsOf(page, 'Anna').filter({ hasText: 'blue' }).locator('.eda-pill-chip-value').click();
  await expect(cards(page)).toHaveCount(3);
  expect(await shownNames(page)).toEqual(['Anna', 'Bert', 'Cleo']);
});
