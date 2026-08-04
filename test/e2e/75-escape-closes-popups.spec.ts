import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The popups a cell renderer opens — the `preview` window and the shared source
 * editor — are read-and-dismiss surfaces, so Escape closes them, exactly as it
 * closes a dialog. It does NOT close a table or view window: that is where the
 * user works, and Esc is not how you put your work away (`closeOnEscape` in
 * panel-shell is opt-in for this reason).
 */

const popups = (page: import('@playwright/test').Page) => page.locator('[id^="easydb-preview-popup-"]');
const editors = (page: import('@playwright/test').Page) => page.locator('[id^="easydb-html-edit-"]');

async function tableWithPreview(page: import('@playwright/test').Page, name: string) {
  const tableId = await createTable(page, name, [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: '<p>Hello <b>World</b></p>' });
  return tableId;
}

test('Escape closes the preview popup', async ({ page }) => {
  const tableId = await tableWithPreview(page, 'escprev');
  const cell = page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td preview-cell');

  await cell.locator('button').click();
  await expect(popups(page)).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(popups(page)).toHaveCount(0);
  // The table window it was opened from is untouched.
  await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();
});

test('Escape closes the topmost popup only, one press at a time', async ({ page }) => {
  const tableId = await tableWithPreview(page, 'escstack');
  const cell = page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td preview-cell');

  // Dispatched, not clicked: the first popup opens over the cell it came from,
  // so a real second click would land on the popup instead of the icon.
  await cell.locator('button').dispatchEvent('click');
  await cell.locator('button').dispatchEvent('click');
  await expect(popups(page)).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect(popups(page)).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(popups(page)).toHaveCount(0);
});

test('Escape closes the source editor from outside its textarea', async ({ page }) => {
  // The textarea used to own the key, so Escape did nothing once the focus moved
  // to the panel chrome or the buttons.
  const tableId = await tableWithPreview(page, 'escedit');
  const cell = page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td preview-cell');

  await cell.locator('[title="Click to edit"]').click();
  await expect(editors(page)).toHaveCount(1);

  await editors(page).locator('.jsPanel-titlebar').click();
  await page.keyboard.press('Escape');
  await expect(editors(page)).toHaveCount(0);
});

test('Escape does NOT close a table window', async ({ page }) => {
  const tableId = await tableWithPreview(page, 'esctable');

  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('.jsPanel-titlebar')
    .click();
  await page.keyboard.press('Escape');

  await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();
});
