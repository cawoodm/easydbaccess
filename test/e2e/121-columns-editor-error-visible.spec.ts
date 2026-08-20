import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * TODO § Quick Wins
 * - A columns-editor error is somewhere the user can see it.
 *
 * The message used to render LAST in the dialog body — below every column row,
 * the Add-column buttons, the deleted-columns list and the live preview. The body
 * scrolls, so on a table with a dozen columns pressing Save moved nothing on
 * screen and said nothing: the reason was a few hundred pixels below the fold.
 *
 * So the test is about VISIBILITY, not about the wording: the banner has to be
 * inside the scroll port when the message appears, wherever the user had scrolled
 * to.
 */

/** Enough columns that the dialog body has to scroll. */
const COLUMNS = Array.from({ length: 14 }, (_, i) => ({ field: `f${i + 1}` }));

test('a validation error is visible without scrolling for it', async ({ page }) => {
  const id = await createTable(page, 'Wide', COLUMNS);
  await waitForPanel(page, id);

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();

  const dialog = page.locator('new-table-dialog dialog');
  await expect(dialog).toBeVisible();
  const body = dialog.locator('.dialog-body');
  const banner = dialog.locator('[data-testid="editor-error"]');
  await expect(banner).toHaveCount(0);

  // Scroll to the bottom of the editor and break the LAST column, which is the
  // shape of the bug: the user is working far from the top of a long list.
  await body.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  const rows = dialog.locator('.col-row');
  await expect(rows).toHaveCount(COLUMNS.length);
  await rows.last().locator('input[type="text"]').first().fill('');

  await dialog.getByRole('button', { name: /^Save$/ }).click();

  // The dialog stays open — nothing was saved — and the reason is on screen.
  await expect(dialog).toBeVisible();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/cannot be empty/i);

  // "Visible" as Playwright means it is not enough here: an element inside a
  // scroll port counts as visible while it sits outside the port. So the box has
  // to be inside the body's own box.
  const boxes = await banner.evaluate((el) => {
    const port = el.closest('.dialog-body') ?? el.parentElement!;
    const b = el.getBoundingClientRect();
    const p = port.getBoundingClientRect();
    return { b: { top: b.top, bottom: b.bottom }, p: { top: p.top, bottom: p.bottom } };
  });
  expect(boxes.b.top).toBeGreaterThanOrEqual(boxes.p.top - 1);
  expect(boxes.b.bottom).toBeLessThanOrEqual(boxes.p.bottom + 1);

  // And it is at the TOP of the body rather than after the columns — the column
  // list starts below it.
  const columnsTop = await dialog.locator('.columns').evaluate((el) => el.getBoundingClientRect().top);
  expect(boxes.b.bottom).toBeLessThanOrEqual(columnsTop + 1);
});

test('the error goes when the problem does', async ({ page }) => {
  const id = await createTable(page, 'Dup', [{ field: 'a' }, { field: 'b' }]);
  await waitForPanel(page, id);

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();

  const dialog = page.locator('new-table-dialog dialog');
  const banner = dialog.locator('[data-testid="editor-error"]');
  const rows = dialog.locator('.col-row');

  // Two columns called `a`.
  await rows.nth(1).locator('input[type="text"]').first().fill('a');
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(/duplicate/i);

  // Fixed, and a second Save both clears the banner and closes the dialog.
  await rows.nth(1).locator('input[type="text"]').first().fill('b');
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(dialog).toBeHidden();
});

/**
 * The ways two columns can end up sharing a name.
 *
 * The duplicate check runs over the field values as typed, so the interesting
 * cases are the ones where two names are not the same STRING but still collide:
 * SQLite column names are case-insensitive, so `Name` and `name` are one column
 * in the file even though the editor sees two.
 */
test.describe('two columns with one name', () => {
  async function editorFor(page: import('@playwright/test').Page, table: string, fields: string[]) {
    const id = await createTable(
      page,
      table,
      fields.map((field) => ({ field })),
    );
    await waitForPanel(page, id);
    await page
      .locator(`#${panelDomId(id)}`)
      .locator('panel-footer')
      .getByRole('button', { name: /Columns/ })
      .click();
    return page.locator('new-table-dialog dialog');
  }

  test('both renamed to the same new name', async ({ page }) => {
    const dialog = await editorFor(page, 'BothRenamed', ['a', 'b']);
    const rows = dialog.locator('.col-row');
    await rows.nth(0).locator('input[type="text"]').first().fill('x');
    await rows.nth(1).locator('input[type="text"]').first().fill('x');
    await dialog.getByRole('button', { name: /^Save$/ }).click();
    await expect(dialog.locator('[data-testid="editor-error"]')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('names that differ only in case', async ({ page }) => {
    const dialog = await editorFor(page, 'CaseOnly', ['a', 'b']);
    const rows = dialog.locator('.col-row');
    await rows.nth(0).locator('input[type="text"]').first().fill('Name');
    await rows.nth(1).locator('input[type="text"]').first().fill('name');
    await dialog.getByRole('button', { name: /^Save$/ }).click();
    await expect(dialog.locator('[data-testid="editor-error"]')).toBeVisible();
    await expect(dialog).toBeVisible();
  });

  test('a name that only collides after the whitespace goes', async ({ page }) => {
    const dialog = await editorFor(page, 'Spaced', ['a', 'b']);
    const rows = dialog.locator('.col-row');
    await rows.nth(1).locator('input[type="text"]').first().fill(' a ');
    await dialog.getByRole('button', { name: /^Save$/ }).click();
    await expect(dialog.locator('[data-testid="editor-error"]')).toBeVisible();
    await expect(dialog).toBeVisible();
  });
});
