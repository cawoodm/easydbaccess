import { expect, test, type Locator, type Page } from './fixtures.js';

/**
 * Searching inside Settings.
 *
 * The dialog has more than a dozen tabs, and which tab a setting lives in is an
 * implementation fact — "Colours a window can be painted" is under Windows, but
 * somebody looking for it may well try Table grid first. So the box searches
 * every tab at once and the result names the tab each field came from.
 *
 * The result rows hold the REAL controls, not a preview: a setting found by
 * searching is changed where it was found.
 */

const openSettings = async (page: Page): Promise<Locator> => {
  await page.goto('/?test=1');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb));
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
};

const search = (dlg: Locator) => dlg.locator('input.search');
const groups = (dlg: Locator) => dlg.locator('.group-head');
const labels = (dlg: Locator) => dlg.locator('.panel .field-head label:not(.scope)');

test('the box searches every tab, and says which tab each match is in', async ({ page }) => {
  const dlg = await openSettings(page);
  // It opens focused, because the reason to open Settings is usually one setting.
  await expect(search(dlg)).toBeFocused();

  await search(dlg).fill('painted');

  await expect(groups(dlg)).toHaveText([/Windows/]);
  await expect(labels(dlg)).toHaveText(['Colours a window can be painted']);
  // The heading counts what was found, not what was searched.
  await expect(dlg.locator('h3')).toHaveText(/1 setting matching/);
});

test('a match found by its description, in a tab the word is not in', async ({ page }) => {
  const dlg = await openSettings(page);
  // "pink" appears only inside the description of two grid settings.
  await search(dlg).fill('pink');

  await expect(groups(dlg)).toHaveText([/Table grid/]);
  await expect(labels(dlg)).toHaveText(['Highlight empty cells', 'Highlight cells Validate flagged']);
});

test('the General tab’s own fields are searchable too', async ({ page }) => {
  // Workspace title and Secrets are hand-rolled controls, not registered specs.
  // The first thing a user searches for that cannot be found teaches them not to
  // search again.
  const dlg = await openSettings(page);
  await search(dlg).fill('secrets');

  await expect(groups(dlg).first()).toHaveText(/General/);
  await expect(dlg.locator('.panel textarea')).toBeVisible();
});

test('the tab list says where the matches are', async ({ page }) => {
  const dlg = await openSettings(page);
  const windowsTab = dlg.locator('nav.tabs button', { hasText: 'Windows' });
  const gridTab = dlg.locator('nav.tabs button', { hasText: 'Table grid' });

  await search(dlg).fill('painted');

  await expect(windowsTab).toHaveClass(/has-hits/);
  await expect(windowsTab.locator('.count')).toHaveText('1');
  await expect(gridTab).toHaveClass(/no-hits/);
});

test('a result can be changed where it was found', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('painted');

  const field = dlg.locator('.panel input[type="text"]');
  await field.fill('red,blue');
  await field.dispatchEvent('change');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dlg).toBeHidden();

  // Stored like any other setting — this is the real control, not a copy of it.
  const stored = await page.evaluate(async () => {
    const app = (window as unknown as { __easydb: { store: { settings: { findOne(k: string): Promise<{ value?: unknown } | null> } } } }).__easydb;
    return (await app.store.settings.findOne('windows:colors'))?.value;
  });
  expect(stored).toBe('red,blue');
});

test('clicking the tab of a group leaves the search and opens that tab', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('painted');
  await groups(dlg).first().click();

  await expect(search(dlg)).toHaveValue('');
  await expect(dlg.locator('h3')).toHaveText('Windows');
  await expect(dlg.locator('nav.tabs button.active')).toHaveText(/Windows/);
});

test('a query nothing matches says so, and keeps the dialog usable', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('zzzznothing');

  await expect(dlg.locator('.panel .empty')).toContainText('Nothing in Settings matches');
  await expect(labels(dlg)).toHaveCount(0);

  // Clearing it puts the tab back, rather than leaving an empty panel.
  await search(dlg).fill('');
  await expect(dlg.locator('h3')).toHaveText('General');
});

test('Escape clears the search before it closes the dialog', async ({ page }) => {
  // The first Escape is the reflex for "undo what I just typed"; throwing the
  // whole dialog away for it costs the user their place.
  const dlg = await openSettings(page);
  await search(dlg).fill('colour');

  await search(dlg).press('Escape');
  await expect(dlg).toBeVisible();
  await expect(search(dlg)).toHaveValue('');

  await search(dlg).press('Escape');
  await expect(dlg).toBeHidden();
});

test('a search does not survive closing and reopening the dialog', async ({ page }) => {
  const dlg = await openSettings(page);
  await search(dlg).fill('colour');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dlg).toBeHidden();

  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  await expect(dlg).toBeVisible();
  await expect(search(dlg)).toHaveValue('');
  await expect(dlg.locator('h3')).toHaveText('General');
});
