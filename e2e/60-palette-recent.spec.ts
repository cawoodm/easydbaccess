import { test, expect } from './fixtures.js';
import { createTable, waitForPanel } from './helpers.js';

/**
 * The command palette keeps the last five commands in a "Recent" section at the
 * top, so Ctrl+K Enter repeats the last one. The history is a workspace setting,
 * so it also survives a reload.
 */

function palette(page: import('@playwright/test').Page) {
  return page.locator('command-palette-dialog dialog');
}

async function openPalette(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+k');
  await expect(palette(page)).toBeVisible();
}

/** Runs a command by typing enough of its title to isolate it. */
async function runCommand(page: import('@playwright/test').Page, query: string, title: string) {
  await openPalette(page);
  await palette(page).locator('input').fill(query);
  await palette(page).locator('.item', { hasText: title }).first().click();
  await expect(palette(page)).toBeHidden();
}

test.describe('command palette recent commands', () => {
  test('the last command runs again on Ctrl+K Enter', async ({ page }) => {
    const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
    await waitForPanel(page, id);
    // The header search box is hidden until something opens it, which is what
    // "Search all tables" does — an effect that can be undone by a reload and
    // then asked for again.
    const search = page.locator('app-shell header input.search');
    await expect(search).toBeHidden();

    await runCommand(page, 'search all', 'Search all tables');
    await expect(search).toBeVisible();

    await page.reload();
    await expect(search).toBeHidden();

    // No typing, no arrow keys: the last command sits at index 0.
    await openPalette(page);
    await page.keyboard.press('Enter');
    await expect(palette(page)).toBeHidden();
    await expect(search).toBeVisible();
  });

  test('a Recent section lists the commands that ran, newest first', async ({ page }) => {
    await runCommand(page, 'cascade', 'Cascade');
    await runCommand(page, 'tile', 'Tile');

    await openPalette(page);
    const head = palette(page).locator('.group-head').first();
    await expect(head).toHaveText('Recent');
    const titles = palette(page).locator('.item .title');
    await expect(titles.nth(0)).toHaveText(/Tile/);
    await expect(titles.nth(1)).toHaveText(/Cascade/);
  });

  test('the history survives a reload and lists a command only once', async ({ page }) => {
    await runCommand(page, 'cascade', 'Cascade');
    await page.reload();

    await openPalette(page);
    await expect(palette(page).locator('.group-head').first()).toHaveText('Recent');
    // Moved into Recent, not copied — so exactly one Cascade entry remains.
    await expect(palette(page).locator('.item .title', { hasText: /Cascade/ })).toHaveCount(1);
  });
});
