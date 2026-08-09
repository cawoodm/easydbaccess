import { test, expect } from './fixtures.js';
import { createTable, waitForPanel } from './helpers.js';

/**
 * A "Go to <table>" command's id carries the table's id, so deleting the table
 * leaves an id in the palette's history that names nothing. It was already
 * skipped when the list was drawn, but it went on occupying one of the five
 * slots — five deleted tables and Recent looked full while showing nothing.
 *
 * Pruned when the palette opens, so it does not matter HOW the table left.
 */

const readRecent = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (window as any).__easydb.store.settings.findOne('palette:recent');
    return Array.isArray(row?.value) ? (row.value as string[]) : [];
  });

async function openPalette(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  return palette;
}

test('the history forgets a deleted table, freeing its slot', async ({ page }) => {
  const keep = await createTable(page, 'Keeper', [{ field: 'a' }]);
  const doomed = await createTable(page, 'Doomed', [{ field: 'a' }]);
  await waitForPanel(page, keep);
  await waitForPanel(page, doomed);

  // Run both "Go to" commands so each is remembered.
  for (const name of ['Doomed', 'Keeper']) {
    const palette = await openPalette(page);
    await palette.locator('input').fill(name);
    await palette
      .locator('.item', { hasText: `Go to: ${name}` })
      .first()
      .click();
    await expect(palette).toBeHidden();
  }
  await expect.poll(async () => (await readRecent(page)).length).toBe(2);
  expect(await readRecent(page)).toEqual([`goto:${keep}`, `goto:${doomed}`]);

  // Delete one straight through the store — the point is that no delete path has
  // to know about the history.
  await page.evaluate(async (id) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.store.tables.remove(id);
  }, doomed);

  // Opening the palette prunes it, and writes the shorter list back.
  const palette = await openPalette(page);
  await expect(palette.locator('.group-head').first()).toHaveText('Recent');
  await expect.poll(async () => await readRecent(page)).toEqual([`goto:${keep}`]);
  // The survivor is still first, so Ctrl+K Enter still repeats it.
  await expect(palette.locator('.item .title').first()).toContainText('Keeper');
});

test('opening the palette with a clean history writes nothing', async ({ page }) => {
  const id = await createTable(page, 'Keeper', [{ field: 'a' }]);
  await waitForPanel(page, id);

  const palette = await openPalette(page);
  await palette.locator('input').fill('Keeper');
  await palette.locator('.item', { hasText: 'Go to: Keeper' }).first().click();
  await expect(palette).toBeHidden();
  await expect.poll(async () => await readRecent(page)).toEqual([`goto:${id}`]);

  const before = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (window as any).__easydb.store.settings.findOne('palette:recent');
    return JSON.stringify(row?.value ?? null);
  });
  await openPalette(page);
  await expect(page.locator('command-palette-dialog dialog')).toBeVisible();
  const after = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (window as any).__easydb.store.settings.findOne('palette:recent');
    return JSON.stringify(row?.value ?? null);
  });
  expect(after).toBe(before);
});
