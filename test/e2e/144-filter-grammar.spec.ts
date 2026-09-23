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

test('a star between two pieces of text finds them in that order', async ({ page }) => {
  const id = await createTable(page, 'People', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Dr Marc Julian Smith' }, { name: 'Marc Julian' }, { name: 'Julian Marc' }, { name: 'Marc Cawood' }]);
  const panel = page.locator(`#${panelDomId(id)}`);
  const rows = panel.locator('data-table tbody tr:not(.spacer)');
  await expect(rows).toHaveCount(4);
  const box = panel.locator('data-table thead filter-combobox input').first();

  // The reported bug: this found nothing, because the inner star was hunted for
  // as a literal asterisk.
  await box.fill('*Marc*Julian*');
  await expect(rows).toHaveCount(2); // Dr Marc Julian Smith, Marc Julian
  // Ordered — "Julian Marc" is the wrong way round.
  await box.fill('*Julian*Marc*');
  await expect(rows).toHaveCount(1);
  // The outer stars still anchor it.
  await box.fill('Marc*Julian*');
  await expect(rows).toHaveCount(1); // only the one that STARTS with Marc
  await box.fill('*Marc*Julian');
  await expect(rows).toHaveCount(1); // only the one that ENDS with Julian
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

test('quoting is how a value containing a comma is filtered on', async ({ page }) => {
  const id = await createTable(page, 'Places', [{ field: 'city' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ city: 'Berlin, DE' }, { city: 'Zurich, CH' }, { city: 'Berlin' }]);
  const panel = page.locator(`#${panelDomId(id)}`);
  const rows = panel.locator('data-table tbody tr:not(.spacer)');
  await expect(rows).toHaveCount(3);
  const box = panel.locator('data-table thead filter-combobox input').first();

  // Unquoted the comma ORs, so "Berlin" or " CH" — all three match one or other.
  await box.fill('Berlin, CH');
  await expect(rows).toHaveCount(3);
  // Quoted, the comma is part of the value, and the value is the whole cell.
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
  // `label.bool` is the setting's own on/off box. It was `label.scope` until
  // v0.0.475, when the storage-layer control beside it became a Workspace /
  // This device pill and took that class with it.
  const toggle = dlg.locator('.panel .field', { hasText: 'Default to substring' }).locator('label.bool').locator('input');
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
