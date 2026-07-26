import { test, expect } from './fixtures.js';

/**
 * TODO § General
 * - Workspace title: editable in Settings → General, shown in the header
 *   instead of "easyDBAccess"; persists across reload; blank reverts to the
 *   default.
 */

test.describe('workspace title', () => {
  test('editing the title in Settings updates the header and persists', async ({ page }) => {
    const header = page.locator('app-shell header');
    await expect(header.locator('strong')).toContainText('easyDBAccess');

    await header.getByTitle('Workspace and plugin settings').click();
    const dialog = page.locator('settings-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();

    const titleInput = dialog.getByPlaceholder('easyDBAccess');
    await titleInput.fill('Acme Inventory');
    await titleInput.blur();

    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(header.locator('strong')).toContainText('Acme Inventory');
    await expect(header.locator('strong')).not.toContainText('easyDBAccess');

    await page.reload();
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb));
    await expect(page.locator('app-shell header strong')).toContainText('Acme Inventory');
  });

  test('clearing the title reverts the header to the default', async ({ page }) => {
    const header = page.locator('app-shell header');
    await header.getByTitle('Workspace and plugin settings').click();
    const dialog = page.locator('settings-dialog');
    const titleInput = dialog.getByPlaceholder('easyDBAccess');

    await titleInput.fill('Temporary Title');
    await titleInput.blur();
    await expect(header.locator('strong')).toContainText('Temporary Title');

    await titleInput.fill('');
    await titleInput.blur();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(header.locator('strong')).toContainText('easyDBAccess');
  });
});
