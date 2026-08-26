import { expect, test, type Locator, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * The funnel in a table window's titlebar shows and hides the filter row — the
 * boxes under the column headers.
 *
 * A lookup table of twelve rows never needs those boxes, while the 600,000-row
 * table beside it always does, so the answer is per window rather than per app.
 * It is kept on the table record, which is what makes it survive a reload.
 *
 * Hiding the row deliberately does NOT clear the filters: they keep narrowing
 * the grid and the header funnel still marks the columns carrying one. A toggle
 * that silently widened the result would be a different feature, and a dangerous
 * one — the rows would come back with no visible reason.
 */

const COLUMNS = [
  { field: 'name', renderer: 'link' },
  { field: 'city', renderer: 'link' },
];

const ROWS = [
  { name: 'Ada', city: 'Bern' },
  { name: 'Bob', city: 'Basel' },
  { name: 'Cid', city: 'Bern' },
];

const panel = (page: Page, id: string) => page.locator(`#${panelDomId(id)}`);
const filterRow = (page: Page, id: string) => panel(page, id).locator('data-table tr.filter-row');
const funnel = (page: Page, id: string) => panel(page, id).locator('.eda-filter-row-btn');
const bodyRows = (page: Page, id: string) => panel(page, id).locator('data-table tbody tr');

async function seed(page: Page, name: string): Promise<string> {
  const id = await createTable(page, name, COLUMNS);
  await bulkAddRows(page, id, ROWS);
  await waitForPanel(page, id);
  return id;
}

const openButtonsTab = async (page: Page): Promise<Locator> => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Buttons', exact: true }).click();
  return dlg;
};

const fieldSwitch = (dlg: Locator, label: string) => dlg.locator('.field', { hasText: label }).locator('label.scope', { hasText: 'enabled' }).locator('input');

test('the filter row is shown by default, and the funnel hides it', async ({ page }) => {
  const id = await seed(page, 'People');

  // Every table drew the boxes before the toggle existed; that stays the default.
  await expect(filterRow(page, id)).toBeVisible();

  await funnel(page, id).click();
  await expect(filterRow(page, id)).toHaveCount(0);

  await funnel(page, id).click();
  await expect(filterRow(page, id)).toBeVisible();
});

test('the button says what the click will do, not what the state is', async ({ page }) => {
  // A titlebar button is read on the way to pressing it.
  const id = await seed(page, 'Labels');
  await expect(funnel(page, id)).toHaveAttribute('title', 'Hide the filter row');
  await expect(funnel(page, id)).toHaveAttribute('aria-pressed', 'true');

  await funnel(page, id).click();
  await expect(funnel(page, id)).toHaveAttribute('title', 'Show the filter row');
  await expect(funnel(page, id)).toHaveAttribute('aria-pressed', 'false');
});

test('the choice is stored on the table and survives a reload', async ({ page }) => {
  const id = await seed(page, 'Persisted');
  await funnel(page, id).click();
  await expect(filterRow(page, id)).toHaveCount(0);
  await expect.poll(async () => (await readTable(page, id)).filterRow).toBe(false);

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await waitForPanel(page, id);
  await expect(filterRow(page, id)).toHaveCount(0);
  await expect(funnel(page, id)).toHaveAttribute('aria-pressed', 'false');
});

test('switching it back on stores nothing rather than storing the default', async ({ page }) => {
  // A table that has been toggled twice should look exactly like one that was
  // never touched — otherwise every table drifts into carrying the field.
  const id = await seed(page, 'Clean');
  await funnel(page, id).click();
  await expect.poll(async () => (await readTable(page, id)).filterRow).toBe(false);
  await funnel(page, id).click();
  await expect.poll(async () => (await readTable(page, id)).filterRow).toBeUndefined();
});

test('hiding the row keeps the filters, and the header funnel still says so', async ({ page }) => {
  const id = await seed(page, 'Narrowed');

  await filterRow(page, id).locator('filter-combobox input').nth(1).fill('Bern');
  await filterRow(page, id).locator('filter-combobox input').nth(1).press('Enter');
  await expect.poll(() => bodyRows(page, id).count()).toBe(2);

  await funnel(page, id).click();
  await expect(filterRow(page, id)).toHaveCount(0);

  // Still two rows — and the column's own funnel is marked, so the reason the
  // other row is missing is still on screen.
  await expect(bodyRows(page, id)).toHaveCount(2);
  await expect(panel(page, id).locator('data-table thead button.funnel.active')).toHaveCount(1);
});

test('two tables toggle independently', async ({ page }) => {
  const a = await seed(page, 'TableA');
  const b = await seed(page, 'TableB');

  await funnel(page, a).click();
  await expect(filterRow(page, a)).toHaveCount(0);
  // The setting is a property of what you are looking at, not of the app.
  await expect(filterRow(page, b)).toBeVisible();
});

test('Settings can take the funnel out of every titlebar', async ({ page }) => {
  const id = await seed(page, 'Hidden');
  await expect(funnel(page, id)).toHaveCount(1);

  const dlg = await openButtonsTab(page);
  await fieldSwitch(dlg, 'Show “Filter row” in window titlebars').uncheck();
  await dlg
    .getByRole('button', { name: /Close|Done|Save/ })
    .first()
    .click();

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await waitForPanel(page, id);

  await expect(funnel(page, id)).toHaveCount(0);
  // Taking the BUTTON away must not take the row away: the setting is about the
  // titlebar, and a table left with its row on keeps it.
  await expect(filterRow(page, id)).toBeVisible();
});

test('the same switch governs the colour button', async ({ page }) => {
  const id = await seed(page, 'NoPalette');
  await expect(panel(page, id).locator('.eda-color-btn')).toHaveCount(1);

  const dlg = await openButtonsTab(page);
  await fieldSwitch(dlg, 'Show “Window colour” in window titlebars').uncheck();
  await dlg
    .getByRole('button', { name: /Close|Done|Save/ })
    .first()
    .click();

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await waitForPanel(page, id);
  await expect(panel(page, id).locator('.eda-color-btn')).toHaveCount(0);
});
