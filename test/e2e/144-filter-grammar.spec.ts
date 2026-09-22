import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The filter box takes a LIST of values or a piece of PLAIN TEXT, and decides by
 * what was typed. Wildcards say which match is wanted; quoting the whole box
 * forces plain text; the `Default to substring` setting decides the rest.
 */

const openSettings = async (page: Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
};

async function seed(page: Page) {
  const id = await createTable(page, 'Days', [{ field: 'type' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ type: 'CC' }, { type: 'Holiday' }, { type: 'Holiday Inn' }, { type: 'Flat' }]);
  const panel = page.locator(`#${panelDomId(id)}`);
  const rows = panel.locator('data-table tbody tr:not(.spacer)');
  await expect(rows).toHaveCount(4);
  return { box: panel.locator('data-table thead filter-combobox input').first(), rows };
}

test('the three wildcards', async ({ page }) => {
  const { box, rows } = await seed(page);
  await box.fill('*lida*');
  await expect(rows).toHaveCount(2); // Holiday, Holiday Inn
  await box.fill('Hol*');
  await expect(rows).toHaveCount(2);
  await box.fill('*Inn');
  await expect(rows).toHaveCount(1);
  await box.fill('*CC');
  await expect(rows).toHaveCount(1);
  await box.fill('CC*');
  await expect(rows).toHaveCount(1);
});

test('a quoted value is the whole cell, not a part of it', async ({ page }) => {
  const { box, rows } = await seed(page);
  await box.fill('"Holiday"');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('input').first()).toHaveValue('Holiday');
});

test('an exclusion keeps the rest of the list', async ({ page }) => {
  const { box, rows } = await seed(page);
  await box.fill('!CC,Holiday');
  await expect(rows).toHaveCount(2); // Holiday, Holiday Inn — CC is out
});

test('quoting the whole box searches for the text as typed', async ({ page }) => {
  const id = await createTable(page, 'Places', [{ field: 'city' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ city: 'Berlin, DE' }, { city: 'Zurich, CH' }, { city: 'Berlin' }]);
  const panel = page.locator(`#${panelDomId(id)}`);
  const rows = panel.locator('data-table tbody tr:not(.spacer)');
  await expect(rows).toHaveCount(3);
  const box = panel.locator('data-table thead filter-combobox input').first();

  // Unquoted the comma ORs, so "Berlin" or " CH" — two of the three.
  await box.fill('Berlin, CH');
  await expect(rows).toHaveCount(3);
  // Quoted, the comma is part of the value.
  await box.fill('"Berlin, DE"');
  await expect(rows).toHaveCount(1);
});

test('the Default to substring setting decides a plain value, and nothing else', async ({ page }) => {
  const { box, rows } = await seed(page);

  // On by default: a plain value is a substring, so "Holiday" takes both.
  await box.fill('Holiday');
  await expect(rows).toHaveCount(2);

  const dlg = await openSettings(page);
  await dlg.getByRole('searchbox', { name: 'Search settings' }).fill('Default to substring');
  const toggle = dlg.locator('.panel .field', { hasText: 'Default to substring' }).locator('label.scope', { hasText: 'enabled' }).locator('input');
  await toggle.uncheck();
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();

  // Off: the plain value is now the whole cell, so only the exact one.
  await box.fill('Holiday');
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('input').first()).toHaveValue('Holiday');

  // The explicit forms are unmoved by the setting.
  await box.fill('*lida*');
  await expect(rows).toHaveCount(2);
  await box.fill('"Holiday"');
  await expect(rows).toHaveCount(1);
});
