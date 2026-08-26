import { expect, test, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A window's own titlebar colour.
 *
 * The automatic colour says what a window IS — every table a shade of blue, a
 * view teal, a visualization violet. Useful until a workspace holds fifteen
 * tables, at which point what you actually want to know is WHICH one, and the
 * palette has nothing left to say. So the colour can be overridden per window,
 * and cleared back to the one its kind gives it.
 */

const GREEN = '#15803d';

const panel = (page: Page, id: string) => page.locator(`#${panelDomId(id)}`);

/** The chrome colour the shell is painting from — window and dock bar alike. */
async function chromeColor(page: Page, id: string): Promise<string> {
  return panel(page, id).evaluate((el) => el.style.getPropertyValue('--eda-panel-color'));
}

const picker = (page: Page) => page.locator('.eda-color-pop');

async function pick(page: Page, id: string, label: string): Promise<void> {
  await panel(page, id).locator('.eda-color-btn').click();
  await expect(picker(page)).toBeVisible();
  // By NAME, not by colour: the swatch carries an aria-label so the control is
  // usable without seeing it, and testable without reading pixels.
  await picker(page).getByRole('menuitemradio', { name: label, exact: true }).click();
  await expect(picker(page)).toBeHidden();
}

test('a table window takes the colour picked for it, and keeps it over a reload', async ({ page }) => {
  const id = await createTable(page, 'Colors', [{ field: 'name' }]);
  await waitForPanel(page, id);
  // A plain local table starts on the kind colour.
  expect(await chromeColor(page, id)).toBe('#01579b');

  await pick(page, id, 'Green');
  await expect.poll(() => chromeColor(page, id)).toBe(GREEN);

  // Stored in the workspace, so it travels with it — not just a live repaint.
  await page.reload();
  await waitForPanel(page, id);
  await expect.poll(() => chromeColor(page, id), { timeout: 15_000 }).toBe(GREEN);
});

test('the default puts the window back on its kind colour', async ({ page }) => {
  const id = await createTable(page, 'Colors', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await pick(page, id, 'Red');
  await expect.poll(() => chromeColor(page, id)).toBe('#b91c1c');

  await pick(page, id, 'Default for this kind');
  await expect.poll(() => chromeColor(page, id)).toBe('#01579b');

  // Cleared, not stored as an empty string: "follows its kind" and "never chosen"
  // are the same state and must not be tellable apart.
  const stored = await page.evaluate(async (tid) => {
    const ctx = (window as unknown as { __easydb: { store: { settings: { findOne(k: string): Promise<unknown> } } } }).__easydb;
    return await ctx.store.settings.findOne(`window-color:${tid}`);
  }, id);
  expect(stored).toBeFalsy();
});

test('the colour is per window: a second table is unaffected', async ({ page }) => {
  const one = await createTable(page, 'One', [{ field: 'name' }]);
  const two = await createTable(page, 'Two', [{ field: 'name' }]);
  await waitForPanel(page, one);
  await waitForPanel(page, two);

  await pick(page, one, 'Green');
  await expect.poll(() => chromeColor(page, one)).toBe(GREEN);
  expect(await chromeColor(page, two)).toBe('#01579b');
});

test('the picker marks the colour in force', async ({ page }) => {
  const id = await createTable(page, 'Colors', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await pick(page, id, 'Teal');
  await panel(page, id).locator('.eda-color-btn').click();
  await expect(picker(page).getByRole('menuitemradio', { name: 'Teal', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(picker(page).getByRole('menuitemradio', { name: 'Default for this kind', exact: true })).toHaveAttribute('aria-checked', 'false');
});

test('opening the picker does not drag or collapse the window behind it', async ({ page }) => {
  // The titlebar is a drag handle and a double-click target, so the button has to
  // claim its own click.
  const id = await createTable(page, 'Colors', [{ field: 'name' }]);
  await waitForPanel(page, id);
  const before = await panel(page, id).boundingBox();

  await panel(page, id).locator('.eda-color-btn').click();
  await expect(picker(page)).toBeVisible();

  const after = await panel(page, id).boundingBox();
  expect(after?.x).toBe(before?.x);
  expect(after?.y).toBe(before?.y);
  expect(after?.height).toBe(before?.height);
});
