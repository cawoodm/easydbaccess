import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The pink background on an empty cell is now a preference (Settings → Table
 * grid). It defaults to on, and turning it off repaints the grids that are
 * already open — there is no settings-changed live query, so `settings-events.ts`
 * is what carries the news.
 *
 * The red "does not fit this type" mark is deliberately NOT covered by the
 * switch: a gap is normal and can be called noise, a bad value cannot.
 */

const openSettings = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Table grid' }).click();
  return dlg;
};

/**
 * The field's own switch. Every field row also carries a "user" checkbox (store
 * on this device only), and that one comes first in the DOM — hence naming the
 * field and then the control inside it rather than taking the first checkbox.
 */
const nullSwitch = (dlg: import('@playwright/test').Locator) => dlg.locator('.field', { hasText: 'Highlight empty cells' }).locator('label.scope', { hasText: 'enabled' }).locator('input');

test('the switch turns the pink off and on again while the table stays open', async ({ page }) => {
  const id = await createTable(page, 'Mixed', [{ field: 'name' }, { field: 'count', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'full', count: 3 },
    { name: 'gaps', count: null },
    { name: 'bad', count: '12abc' },
  ]);

  const table = page.locator(`#${panelDomId(id)} data-table`);
  await expect(table.locator('tbody tr:not(.spacer)')).toHaveCount(3);
  // On by default: one empty cell is pink, one bad value is red.
  await expect(table.locator('td.is-null')).toHaveCount(1);
  await expect(table.locator('td.is-invalid')).toHaveCount(1);

  const dlg = await openSettings(page);
  const toggle = nullSwitch(dlg);
  // On by default, and the dialog says so — a switch that reads "off" while the
  // pink is showing would take two clicks to turn off.
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  // Repainted with the dialog still open — no reload, no reopening the window.
  await expect(table.locator('td.is-null')).toHaveCount(0);
  // …and the invalid mark is untouched by this switch.
  await expect(table.locator('td.is-invalid')).toHaveCount(1);

  await toggle.check();
  await expect(table.locator('td.is-null')).toHaveCount(1);
});

test('the choice is remembered, and a table opened later respects it', async ({ page }) => {
  const first = await createTable(page, 'One', [{ field: 'a' }]);
  await waitForPanel(page, first);
  await bulkAddRows(page, first, [{ a: null }]);

  const dlg = await openSettings(page);
  await nullSwitch(dlg).uncheck();
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();

  // A table created AFTER the change starts unhighlighted — the grid reads the
  // setting on mount, not only when the event fires.
  const second = await createTable(page, 'Two', [{ field: 'b' }]);
  await waitForPanel(page, second);
  await bulkAddRows(page, second, [{ b: null }]);
  await expect(page.locator(`#${panelDomId(second)} data-table tbody tr:not(.spacer)`)).toHaveCount(1);
  await expect(page.locator('data-table td.is-null')).toHaveCount(0);

  // And it survives a reload, because it is a stored workspace setting.
  await page.reload();
  await expect(page.locator(`#${panelDomId(second)} data-table tbody tr:not(.spacer)`)).toHaveCount(1);
  await expect(page.locator('data-table td.is-null')).toHaveCount(0);
});
