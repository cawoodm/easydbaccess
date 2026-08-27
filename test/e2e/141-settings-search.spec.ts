import { test, expect, type Page } from './fixtures.js';

/**
 * One box above the tabs searches every tab at once.
 *
 * The dialog has a tab per feature and the list keeps growing, so the only way to
 * find "the thing that stops the pink cells" was to open each tab and read. A
 * query shows what matched under the tab it came from — the answer to "where is
 * it" — and the control in the results is the real one, so it can be changed from
 * there without navigating at all.
 */

const openSettings = async (page: Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
};

const search = (dlg: import('@playwright/test').Locator) => dlg.getByRole('searchbox', { name: 'Search settings' });
const panel = (dlg: import('@playwright/test').Locator) => dlg.locator('.panel');

test('a query finds a setting on a tab you are not on, and says which tab', async ({ page }) => {
  const dlg = await openSettings(page);
  // Opens on General, and the pink-cells switch is on the Table grid tab.
  await expect(panel(dlg)).toContainText('Workspace title');

  await search(dlg).fill('pink');

  await expect(panel(dlg)).toContainText('Table grid');
  await expect(panel(dlg)).toContainText('Highlight empty cells');
  // Only what matched: the tab's other fields are not dragged along.
  await expect(panel(dlg)).not.toContainText('Sort descending first');
});

test('the control in the results is the real one', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('pink');

  const toggle = panel(dlg).locator('.field', { hasText: 'Highlight empty cells' }).locator('label.scope', { hasText: 'enabled' }).locator('input');
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  // Saved from the results, with no tab visited: reopening shows it off.
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  const again = await openSettings(page);
  await again.getByRole('button', { name: 'Table grid' }).click();
  await expect(panel(again).locator('.field', { hasText: 'Highlight empty cells' }).locator('label.scope', { hasText: 'enabled' }).locator('input')).not.toBeChecked();
});

test('every word has to match, so a second word narrows', async ({ page }) => {
  const dlg = await openSettings(page);

  await search(dlg).fill('map');
  await expect(panel(dlg)).toContainText('Map tile URL template');

  await search(dlg).fill('map attribution');
  await expect(panel(dlg)).toContainText('Map attribution');
  await expect(panel(dlg)).not.toContainText('Map tile URL template');
});

test('the General tab’s own boxes are searchable too', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('secrets');

  await expect(panel(dlg)).toContainText('General');
  await expect(panel(dlg)).toContainText('Secrets');
  // The store itself, not just its heading.
  await expect(panel(dlg).locator('textarea')).toBeVisible();
});

test('a query that matches nothing says so, naming what was typed', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('zzzznothing');
  await expect(panel(dlg)).toContainText('No setting matches');
  await expect(panel(dlg)).toContainText('zzzznothing');
});

test('clearing the search, or picking a tab, goes back to the tabs', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('pink');
  await expect(panel(dlg)).toContainText('Highlight empty cells');

  // The ✕ in the box.
  await dlg.getByRole('button', { name: 'Clear the search' }).click();
  await expect(search(dlg)).toHaveValue('');
  await expect(panel(dlg)).toContainText('Workspace title');

  // A tab click ends a search too — the tab IS the answer to "where is it".
  await search(dlg).fill('pink');
  await dlg.getByRole('button', { name: 'Links' }).click();
  await expect(search(dlg)).toHaveValue('');
  await expect(panel(dlg)).toContainText('Protocols that may be links');
});

test('a fresh open starts with no query', async ({ page }) => {
  const first = await openSettings(page);
  await search(first).fill('pink');
  await first.getByRole('button', { name: 'Done', exact: true }).click();

  const second = await openSettings(page);
  await expect(search(second)).toHaveValue('');
  await expect(panel(second)).toContainText('Workspace title');
});
