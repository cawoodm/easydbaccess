import { test, expect, type Page } from './fixtures.js';

/**
 * Connect has two halves.
 *
 * It used to mean one thing — point a window at somebody else's live table and
 * store nothing — and there was exactly one connector, so the button went
 * straight to Datasette and no menu was ever seen. It now asks first: your own
 * data, or someone else's system.
 *
 * The half that is new is Local Data, and the rule worth holding down is that
 * switching a file off is NOT a view filter: the file is not read, not
 * compared and never written. The pure side of that lives in
 * `test/renderer/db/folder-index.test.ts`; what this spec covers is the part
 * only a browser can show — the menu, the dialog, and the workspace list
 * actually losing the entry.
 *
 * The folder itself cannot be granted from a test: `showDirectoryPicker` is a
 * native dialog Playwright cannot drive. So the scan RESULT is seeded instead,
 * which is what every reader downstream of the picker actually consumes.
 */

const INDEX_KEY = 'eda:folderIndex';
const FILES_KEY = 'eda:folderFiles';

/** A folder that has already been scanned, as the index cache records it. */
function seedFolder(page: Page) {
  return page.addInitScript(
    ([indexKey, filesKey]) => {
      localStorage.removeItem(filesKey);
      localStorage.setItem(
        indexKey,
        JSON.stringify({
          folder: 'e2e-workspaces',
          at: Date.now() - 60_000,
          files: ['sales.edb', 'notes.edb', 'archive.edb'],
          workspaces: [
            { id: 'sales', name: 'sales', title: 'Sales', file: 'sales.edb', tables: 4, views: 2, size: 131072 },
            { id: 'notes', name: 'notes', title: 'Notes', file: 'notes.edb', tables: 9, views: 1, size: 524288 },
            { id: 'arch', name: 'arch', title: 'Archive', file: 'archive.edb', tables: 31, views: 0, size: 4300000 },
          ],
        }),
      );
    },
    [INDEX_KEY, FILES_KEY] as const,
  );
}

/** Click Connect, then the named half. The menu is a popover in the top layer. */
async function openHalf(page: Page, half: 'Local Data' | 'Remote System') {
  await page.locator('app-shell header button', { hasText: 'Connect' }).first().click();
  const menu = page.locator('anchored-menu');
  await expect(menu).toBeVisible();
  await menu.getByText(half, { exact: true }).click();
}

const dialog = (page: Page) => page.locator('local-data-dialog dialog');

test('Connect asks local or remote before it asks anything else', async ({ page }) => {
  await page.locator('app-shell header button', { hasText: 'Connect' }).first().click();
  const menu = page.locator('anchored-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByText('Local Data', { exact: true })).toBeVisible();
  await expect(menu.getByText('Remote System', { exact: true })).toBeVisible();
});

test('Local Data opens the folder dialog, and says so when no folder is connected', async ({ page }) => {
  await openHalf(page, 'Local Data');
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('heading', { name: 'Local Data' })).toBeVisible();
  await expect(dialog(page).getByText('No folder connected')).toBeVisible();
  // Always offered: a file outside the folder is the one local thing every
  // browser can do, folder picker or not.
  await expect(dialog(page).getByRole('button', { name: /Open a workspace file/ })).toBeVisible();
});

test('a scanned folder lists its files, ticked and locked while "every .edb" is on', async ({ page, workspaceId }) => {
  await seedFolder(page);
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  await openHalf(page, 'Local Data');
  await expect(dialog(page).getByText('e2e-workspaces')).toBeVisible();

  const boxes = dialog(page).locator('li input[type=checkbox]');
  await expect(boxes).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(boxes.nth(i)).toBeChecked();
    await expect(boxes.nth(i)).toBeDisabled();
  }
});

test('unticking "every .edb" hides nothing by itself', async ({ page, workspaceId }) => {
  await seedFolder(page);
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await openHalf(page, 'Local Data');

  await dialog(page).locator('.all input').uncheck();

  // Every box stays ticked, and is now live. Unticking the rule must not be a
  // way to lose three workspaces in one click.
  const boxes = dialog(page).locator('li input[type=checkbox]');
  for (let i = 0; i < 3; i++) {
    await expect(boxes.nth(i)).toBeChecked();
    await expect(boxes.nth(i)).toBeEnabled();
  }
});

test('a file switched off leaves the workspace list', async ({ page, workspaceId }) => {
  await seedFolder(page);
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  const selector = page.locator('app-shell workspace-selector');
  await expect(selector).toContainText('Archive');

  await openHalf(page, 'Local Data');
  await dialog(page).locator('.all input').uncheck();
  await dialog(page).locator('li', { hasText: 'Archive' }).locator('input[type=checkbox]').uncheck();

  await expect(selector).not.toContainText('Archive');
  // The others are untouched — this is one file, not a mode.
  await expect(selector).toContainText('Sales');
  await expect(selector).toContainText('Notes');

  // And it is remembered, so the next boot does not quietly bring it back.
  // Membership, not order — the list is built from the rendered rows, and what
  // order those happen to be in is not a promise to anyone.
  const stored = JSON.parse((await page.evaluate((k) => localStorage.getItem(k), FILES_KEY)) ?? '{}') as { all: boolean; files: string[] };
  expect(stored.all).toBe(false);
  expect([...stored.files].sort()).toEqual(['notes.edb', 'sales.edb']);
});

test('Remote System still goes where Connect always went', async ({ page }) => {
  await openHalf(page, 'Remote System');
  // One remote connector is installed, so the second level is skipped and the
  // Datasette dialog opens directly — the behaviour this change had to keep.
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
});
