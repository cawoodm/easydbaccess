import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Empty and invalid cells are marked on the `<td>` from the STORED value, so the
 * marking survives any renderer. The old check read the rendered DOM, which a
 * renderer could hide: a boolean's checkbox and an image cell both look
 * "non-empty" even with nothing stored.
 */
test('empty cells go pink and invalid ones get the red outline, whatever the renderer', async ({
  page,
}) => {
  const id = await createTable(page, 'Mixed', [
    { field: 'name' },
    { field: 'done', type: 'boolean', renderer: 'boolean' },
    { field: 'count', type: 'number' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'full', done: true, count: 3 },
    // done is empty although the boolean renderer still draws a checkbox for it;
    // count holds a value a number column cannot mean.
    { name: 'gaps', done: null, count: '12abc' },
  ]);

  const table = page.locator(`#${panelDomId(id)} data-table`);
  await expect(table.locator('tbody tr:not(.spacer)')).toHaveCount(2);

  // Row order in the DOM is not the insert order, so assert per cell kind
  // instead of per row index. Exactly the two bad cells of the "gaps" row are
  // marked, one each way.
  await expect(table.locator('td.is-null')).toHaveCount(1);
  await expect(table.locator('td.is-invalid')).toHaveCount(1);

  // The empty boolean is pink even though its renderer still draws a checkbox.
  const emptyCell = table.locator('td.is-null');
  await expect(emptyCell).toHaveClass(/t-boolean/);
  await expect(emptyCell.locator('input[type="checkbox"]')).toHaveCount(1);

  // The unparseable number carries the invalid outline, not the pink.
  const badCell = table.locator('td.is-invalid');
  await expect(badCell).toHaveClass(/t-number/);
  await expect(badCell).not.toHaveClass(/is-null/);
});
