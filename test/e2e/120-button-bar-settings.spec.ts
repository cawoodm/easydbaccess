import { test, expect } from './fixtures.js';

/**
 * Settings → Buttons: the two "text in … buttons" switches, and one switch per
 * registered header/footer button.
 *
 * The per-button fields cannot be declared in advance — which buttons exist is
 * whatever the enabled plugins registered — so the shell builds the tab from its
 * own snapshot of the bars. That is what this spec is really covering: the tab
 * lists the buttons that are actually there, and unticking one takes it out of
 * the bar while the dialog is still open.
 */

type Page = import('@playwright/test').Page;
type Locator = import('@playwright/test').Locator;

const openButtonsTab = async (page: Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Buttons', exact: true }).click();
  return dlg;
};

/**
 * The full field label, quotes and all: `hasText` matches case-insensitively on
 * a substring, and "New Table" alone also hits the Paste CSV field, whose
 * description ends "…to create a new table".
 */
const SHOW_NEW_TABLE = 'Show “New Table” in the header';

/** A boolean field's own switch — the row's first checkbox is the "user" one. */
const fieldSwitch = (dlg: Locator, label: string) => dlg.locator('.field', { hasText: label }).locator('label.scope', { hasText: 'enabled' }).locator('input');

const headerLabels = (page: Page) => page.locator('app-shell header button.primary .btn-label');
const footerLabels = (page: Page) => page.locator('app-shell footer button .btn-label');
const newTableButton = (page: Page) => page.locator('app-shell header button.primary', { hasText: 'New Table' });

test.describe('button bar settings', () => {
  test('text is on by default and can be switched off per bar', async ({ page }) => {
    await expect(newTableButton(page)).toBeVisible();
    const headerCount = await page.locator('app-shell header button.primary').count();
    expect(await headerLabels(page).count()).toBe(headerCount);
    expect(await footerLabels(page).count()).toBeGreaterThan(0);

    const dlg = await openButtonsTab(page);
    const headerText = fieldSwitch(dlg, 'Text in header buttons');
    await expect(headerText).toBeChecked();
    await uncheck(headerText);

    // Icons only, with the dialog still open — and every button still there.
    await expect(headerLabels(page)).toHaveCount(0);
    expect(await page.locator('app-shell header button.primary').count()).toBe(headerCount);
    // The footer is a separate switch, so it is untouched.
    expect(await footerLabels(page).count()).toBeGreaterThan(0);

    await check(headerText);
    await expect(headerLabels(page)).toHaveCount(headerCount);
  });

  test('a button can be hidden, and stays hidden after a reload', async ({ page }) => {
    const dlg = await openButtonsTab(page);
    // The tab lists the buttons that are really in the bar.
    const own = fieldSwitch(dlg, SHOW_NEW_TABLE);
    await expect(own).toBeChecked();
    await uncheck(own);

    await expect(newTableButton(page)).toHaveCount(0);
    await dlg.getByRole('button', { name: 'Done', exact: true }).click();

    await page.reload();
    await expect(page.locator('app-shell header')).toBeVisible();
    await expect(newTableButton(page)).toHaveCount(0);

    // And back again.
    const reopened = await openButtonsTab(page);
    await check(fieldSwitch(reopened, SHOW_NEW_TABLE));
    await expect(newTableButton(page)).toBeVisible();
  });
});

// The switch sits inside a shadow root and Playwright's own check()/uncheck()
// re-reads it after the click; a plain click plus a state assertion is enough
// here and does not race the re-render.
async function uncheck(box: Locator) {
  await box.click();
  await expect(box).not.toBeChecked();
}

async function check(box: Locator) {
  await box.click();
  await expect(box).toBeChecked();
}
