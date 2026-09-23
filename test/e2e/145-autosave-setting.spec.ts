import { test, expect, type Page } from './fixtures.js';

/**
 * Autosave is reachable from Settings, not only from the command palette.
 *
 * The behaviour already existed; what did not was any way to FIND it. A command
 * behind a palette search is not somewhere a user looks for a preference.
 *
 * Both ways in drive one record, so what these tests pin is that the two stay in
 * step — in particular that the tick box reaches the LIVE timer and not only the
 * stored value. Writing the record alone would change what a reload does and
 * nothing else, which is the trap this plugin has already fallen into once.
 */

const openSettings = async (page: Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
};

const closeSettings = async (page: Page) => {
  const dlg = page.locator('settings-dialog dialog');
  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();
};

/** The Autosave field's own on/off box, found through the settings search. */
async function autosaveBox(page: Page) {
  const dlg = await openSettings(page);
  await dlg.getByRole('searchbox', { name: 'Search settings' }).fill('Autosave');
  return dlg.locator('.panel .field', { hasText: 'Autosave' }).locator('label.bool').locator('input');
}

/** What the palette calls the toggle — which is read off the LIVE policy. */
async function paletteAutosaveTitle(page: Page): Promise<string[]> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('autosave');
  const titles = await palette.locator('.item').allInnerTexts();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
  return titles;
}

test('Autosave is a field in Settings, off to start with', async ({ page }) => {
  const box = await autosaveBox(page);
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await closeSettings(page);
});

test('ticking it reaches the live timer, not just the stored value', async ({ page }) => {
  // The palette names the command from `autosave.enabled()`, so its title is the
  // one observable that says the running policy agrees with the record.
  expect((await paletteAutosaveTitle(page)).join(' ')).toContain('Turn on autosave');

  const box = await autosaveBox(page);
  await box.check();
  await closeSettings(page);

  expect((await paletteAutosaveTitle(page)).join(' ')).toContain('Turn off autosave');
});

test('the palette toggle shows up in Settings, so the two are one setting', async ({ page }) => {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('autosave');
  await palette.locator('.item').first().click();
  await expect(palette).toBeHidden();

  const box = await autosaveBox(page);
  await expect(box).toBeChecked();
  await closeSettings(page);
});
