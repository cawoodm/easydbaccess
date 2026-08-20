import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Empty and invalid cells are marked on the `<td>` from the STORED value, so the
 * marking survives any renderer. The old check read the rendered DOM, which a
 * renderer could hide: a boolean's checkbox and an image cell both look
 * "non-empty" even with nothing stored.
 */
test('empty cells go pink and invalid ones get the red outline, whatever the renderer', async ({ page }) => {
  // The invalid case rides on a DATE column rather than a number one. A number
  // column is REAL affinity and `sql-mapping.ts`'s `encodeValue` turns anything
  // that will not parse into SQL NULL, so `'12abc'` comes back empty, not
  // invalid. A date is stored as text verbatim, so a value that does not parse
  // survives the round trip — which is what the marking is for.
  const id = await createTable(page, 'Mixed', [{ field: 'name' }, { field: 'done', type: 'boolean', renderer: 'boolean' }, { field: 'due', type: 'date' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'full', done: true, due: '2026-01-31' },
    // done is empty although the boolean renderer still draws a checkbox for it;
    // due holds a value a date column cannot mean.
    { name: 'gaps', done: null, due: 'next tuesday' },
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

  // The unparseable date carries the invalid outline, not the pink.
  const badCell = table.locator('td.is-invalid');
  await expect(badCell).toHaveClass(/t-date/);
  await expect(badCell).not.toHaveClass(/is-null/);
});
