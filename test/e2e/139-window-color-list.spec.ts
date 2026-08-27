import { expect, test, type Locator, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Which colours a window can be painted is a setting (Settings → Windows): hex
 * values or HTML colour names, comma-separated. Before it, the nine shipped
 * colours were the only ones there were.
 *
 * The list is resolved into module state at boot and re-resolved when the dialog
 * reports a change (`window-mgr/window-color-settings.ts`), because the picker is
 * built inside a click handler and reading a setting is async.
 */

const panel = (page: Page, id: string) => page.locator(`#${panelDomId(id)}`);
const picker = (page: Page) => page.locator('.eda-color-pop');

async function openPicker(page: Page, id: string): Promise<Locator> {
  await panel(page, id).locator('.eda-color-btn').click();
  await expect(picker(page)).toBeVisible();
  return picker(page);
}

/** Every swatch's accessible name, in the order the picker shows them. */
async function offered(page: Page, id: string): Promise<string[]> {
  const pop = await openPicker(page, id);
  const names = await pop.getByRole('menuitemradio').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label') ?? ''));
  await page.keyboard.press('Escape');
  return names;
}

async function openWindowsTab(page: Page): Promise<Locator> {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Windows' }).click();
  return dlg;
}

const colorsField = (dlg: Locator) => dlg.locator('.field', { hasText: 'Colours a window can be painted' }).locator('input[type="text"]');

async function setColorList(page: Page, value: string): Promise<void> {
  const dlg = await openWindowsTab(page);
  const field = colorsField(dlg);
  await field.fill(value);
  await field.dispatchEvent('change');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dlg).toBeHidden();
}

const chromeColor = (page: Page, id: string) => panel(page, id).evaluate((el) => el.style.getPropertyValue('--eda-panel-color'));

test('the field opens on the shipped list, which is what the picker offers', async ({ page }) => {
  const id = await createTable(page, 'Palette', [{ field: 'a' }]);
  await waitForPanel(page, id);

  expect(await offered(page, id)).toEqual(['Default for this kind', 'Slate', 'Teal', 'Green', 'Olive', 'Amber', 'Red', 'Pink', 'Violet']);

  const dlg = await openWindowsTab(page);
  await expect(colorsField(dlg)).toHaveValue('#334155,#0f766e,#15803d,#4d7c0f,#b45309,#b91c1c,#a21caf,#6d28d9');
});

test('a configured list replaces what the picker offers, with no reload', async ({ page }) => {
  const id = await createTable(page, 'Palette', [{ field: 'a' }]);
  await waitForPanel(page, id);

  await setColorList(page, '#FF00DD,red,blue');

  // The picker is built fresh on every open, so the new list is there at once.
  expect(await offered(page, id)).toEqual(['Default for this kind', '#FF00DD', 'Red', 'Blue']);
});

test('a colour from the configured list paints the window', async ({ page }) => {
  const id = await createTable(page, 'Palette', [{ field: 'a' }]);
  await waitForPanel(page, id);
  expect(await chromeColor(page, id)).toBe('#01579b'); // the kind colour

  await setColorList(page, '#FF00DD,blue');
  const pop = await openPicker(page, id);
  await pop.getByRole('menuitemradio', { name: '#FF00DD', exact: true }).click();
  await expect(pop).toBeHidden();

  await expect.poll(() => chromeColor(page, id)).toBe('#FF00DD');
  // Stored with the workspace like any other window colour.
  await page.reload();
  await waitForPanel(page, id);
  await expect.poll(() => chromeColor(page, id), { timeout: 15_000 }).toBe('#FF00DD');
});

test('an entry that is not a colour is ignored, and the rest of the list stands', async ({ page }) => {
  const id = await createTable(page, 'Palette', [{ field: 'a' }]);
  await waitForPanel(page, id);

  await setColorList(page, 'red,burgundy,blue');

  // One typo costs its own entry only — not the two colours beside it.
  expect(await offered(page, id)).toEqual(['Default for this kind', 'Red', 'Blue']);
});

test('emptying the field goes back to the shipped list', async ({ page }) => {
  const id = await createTable(page, 'Palette', [{ field: 'a' }]);
  await waitForPanel(page, id);

  await setColorList(page, 'blue');
  expect(await offered(page, id)).toEqual(['Default for this kind', 'Blue']);

  await setColorList(page, '');
  // Not an empty picker: there is no way to end up with only "Kind" on offer.
  expect(await offered(page, id)).toEqual(['Default for this kind', 'Slate', 'Teal', 'Green', 'Olive', 'Amber', 'Red', 'Pink', 'Violet']);
});

test('a window keeps a colour the list no longer offers', async ({ page }) => {
  // The list says what may be CHOSEN from now on. Rewriting it must not repaint
  // the windows a user has already coloured.
  const id = await createTable(page, 'Palette', [{ field: 'a' }]);
  await waitForPanel(page, id);

  const pop = await openPicker(page, id);
  await pop.getByRole('menuitemradio', { name: 'Green', exact: true }).click();
  await expect.poll(() => chromeColor(page, id)).toBe('#15803d');

  await setColorList(page, 'red,blue');
  expect(await chromeColor(page, id)).toBe('#15803d');
  // Nothing is ringed, because the colour in force is no longer on the list.
  const after = await openPicker(page, id);
  await expect(after.getByRole('menuitemradio', { name: 'Default for this kind', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(after.getByRole('menuitemradio', { name: 'Red', exact: true })).toHaveAttribute('aria-checked', 'false');
});
