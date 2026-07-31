import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * An editor holding unsaved edits cancels `beforeunload`, so the browser asks
 * before it leaves or reloads the page. A dev server's automatic reload used to
 * wipe a half-finished columns editor or a half-typed token without a word.
 *
 * The tests dispatch a cancelable `beforeunload` and read `defaultPrevented` —
 * the same signal the browser acts on, and deterministic, unlike the native
 * confirm dialog.
 */

function unloadBlocked(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
}

test('nothing blocks a reload while no editor is open', async ({ page }) => {
  expect(await unloadBlocked(page)).toBe(false);
});

test('the columns editor blocks a reload once edited, and releases on close', async ({ page }) => {
  const id = await createTable(page, 'Widgets', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();

  // Open but untouched — no work to lose yet.
  expect(await unloadBlocked(page)).toBe(false);

  await dlg.locator('.col-row input').first().fill('renamed');
  expect(await unloadBlocked(page)).toBe(true);

  // Cancelling is a decision about the work, so the guard lets go.
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden();
  expect(await unloadBlocked(page)).toBe(false);
});

test('the settings dialog blocks a reload once edited, and releases when done', async ({ page }) => {
  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })),
  );
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Gist Sync' }).click();

  expect(await unloadBlocked(page)).toBe(false);

  await dlg.locator('input[type="text"], input[type="password"]').first().fill('ghp_example');
  expect(await unloadBlocked(page)).toBe(true);

  await dlg.getByRole('button', { name: 'Done' }).click();
  await expect(dlg).toBeHidden();
  expect(await unloadBlocked(page)).toBe(false);
});
