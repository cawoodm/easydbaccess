import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `array` column type: a cell holds SEVERAL values, spelled either as a
 * comma list (`foo,bar`) or as a JSON array (`["Foo","Bar"]`).
 *
 * What it buys is the funnel dropdown. On a `string` column a list cell is one
 * long value, so the dropdown offers one useless option per row and picking it
 * matches nothing — the popover writes an EXACT token, and no single value ever
 * equals the whole list. Typed `array`, the dropdown offers the members and a
 * pick keeps every row whose list contains it.
 */

const rows = [
  { name: 'a', tags: 'red,blue' },
  { name: 'b', tags: 'blue,green' },
  { name: 'c', tags: 'red' },
];

async function tagTable(
  page: import('@playwright/test').Page,
  name: string,
  type: 'array' | 'string',
) {
  const id = await createTable(page, name, [{ field: 'name' }, { field: 'tags', type }]);
  await waitForPanel(page, id);
  for (const r of rows) await addRow(page, id, r);
  return id;
}

function visibleRows(page: import('@playwright/test').Page, id: string) {
  return page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer):visible`);
}

test('the dropdown offers each member, counted across the rows', async ({ page }) => {
  const id = await tagTable(page, 'Tags', 'array');
  const panel = page.locator(`#${panelDomId(id)}`);
  await panel.locator('data-table thead th button.funnel').nth(1).click();

  const popover = page.locator('filter-popover');
  await expect(popover).toBeVisible();
  // Three members, commonest first: blue (2), red (2) tie alphabetically, green (1).
  const items = popover.locator('li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('blue');
  await expect(items.nth(0)).toContainText('2');
  await expect(items.nth(1)).toContainText('red');
  await expect(items.nth(2)).toContainText('green');
});

test('picking a member keeps every row whose list contains it', async ({ page }) => {
  const id = await tagTable(page, 'Pick', 'array');
  const panel = page.locator(`#${panelDomId(id)}`);
  await panel.locator('data-table thead th button.funnel').nth(1).click();

  const popover = page.locator('filter-popover');
  await popover.locator('li').filter({ hasText: 'red' }).click();
  // 'red,blue' and 'red' — the member match, not a whole-cell match.
  await expect(visibleRows(page, id)).toHaveCount(2);

  // A second member ORs in: blue adds row b.
  await popover.locator('li').filter({ hasText: 'green' }).click();
  await expect(visibleRows(page, id)).toHaveCount(3);
});

test('the same column typed string offers whole cells and matches nothing', async ({ page }) => {
  // The behaviour the type exists to fix, pinned so it cannot come back.
  const id = await tagTable(page, 'Plain', 'string');
  const panel = page.locator(`#${panelDomId(id)}`);
  await panel.locator('data-table thead th button.funnel').nth(1).click();

  const popover = page.locator('filter-popover');
  const items = popover.locator('li');
  await expect(items).toHaveCount(3);
  await expect(items.filter({ hasText: 'red,blue' })).toHaveCount(1);
  // No option for a single tag on its own.
  await expect(items.filter({ hasText: /^blue/ })).toHaveCount(0);
});

test('a JSON-array cell reads the same as a comma list', async ({ page }) => {
  const id = await createTable(page, 'Json', [{ field: 'name' }, { field: 'tags', type: 'array' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'a', tags: '["Red","Blue"]' });
  await addRow(page, id, { name: 'b', tags: 'Blue,Green' });

  const panel = page.locator(`#${panelDomId(id)}`);
  await panel.locator('data-table thead th button.funnel').nth(1).click();
  const popover = page.locator('filter-popover');
  // Three members from two cells written two different ways.
  await expect(popover.locator('li')).toHaveCount(3);

  await popover.locator('li').filter({ hasText: 'Blue' }).click();
  // Both rows carry Blue — one as JSON, one as a comma list.
  await expect(visibleRows(page, id)).toHaveCount(2);
});

test('a list with no members shows an empty cell, not the brackets', async ({ page }) => {
  // `[]` is how an absent list arrives from most exports. Showing it as "[]" reads
  // as content where there is none.
  const id = await createTable(page, 'Empty', [{ field: 'name' }, { field: 'tags', type: 'array' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'a', tags: '[]' });
  await addRow(page, id, { name: 'b', tags: null });
  await addRow(page, id, { name: 'c', tags: 'red' });

  const cells = page.locator(`#${panelDomId(id)} data-table tbody td.t-array`);
  await expect(cells).toHaveCount(3);
  // Rows come back in row-id order, which is random, so compare them as a set.
  const values = () =>
    cells
      .locator('input')
      .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).sort());
  await expect.poll(values).toEqual(['', '', 'red']);

  // Both empty lists are marked empty, like any other blank cell, and carry no
  // tooltip — there is nothing to read.
  await expect(page.locator(`#${panelDomId(id)} data-table tbody td.t-array.is-null`)).toHaveCount(
    2,
  );
  const titles = await cells.evaluateAll((els) => els.map((e) => e.getAttribute('title')).sort());
  expect(titles).toEqual(['', '', 'red']);
});

test('typing a member in the filter box matches, and NULL finds the empty lists', async ({
  page,
}) => {
  const id = await createTable(page, 'Typed', [{ field: 'name' }, { field: 'tags', type: 'array' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'a', tags: 'red,blue' });
  await addRow(page, id, { name: 'b', tags: '[]' });
  await addRow(page, id, { name: 'c', tags: '' });

  const panel = page.locator(`#${panelDomId(id)}`);
  const box = panel.locator('data-table thead tr.filter-row input').nth(1);
  await box.fill('=blue');
  await expect(visibleRows(page, id)).toHaveCount(1);

  // `[]` is text but holds no values, so it counts as empty like a blank cell.
  await box.fill('NULL');
  await expect(visibleRows(page, id)).toHaveCount(2);
});
