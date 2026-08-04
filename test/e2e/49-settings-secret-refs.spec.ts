import { test, expect } from './fixtures.js';

/**
 * The Settings dialog refuses to close while a `${secret:name}` reference points
 * at a name the secrets store does not define. Such a reference resolves to
 * through unresolved, so the plugin uses the literal `${secret:name}` text as
 * its token and the failure only shows up as a rejected request later.
 *
 * The store's format is `name: value` (one per line) — see parseSecrets.
 *
 * Driven through the Gist Sync tab's "GitHub token (PAT)" field, the one secret
 * field a stock workspace has.
 */
test.describe('settings secret references', () => {
  const openSettings = async (page: import('@playwright/test').Page) => {
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
    const dlg = page.locator('settings-dialog dialog');
    await expect(dlg).toBeVisible();
    return dlg;
  };

  test('a reference to an unknown secret blocks the close until it exists', async ({ page }) => {
    const dlg = await openSettings(page);

    // Gist Sync tab → put a dangling reference into the token field.
    await dlg.getByRole('button', { name: 'Gist Sync' }).click();
    const token = dlg.locator('.secret-row input');
    await token.fill('${secret:gist_pat}');
    await token.dispatchEvent('change');

    // Blocked: the dialog stays open, names the missing secret, and the field
    // carries the invalid (red) border.
    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toBeVisible();
    const error = dlg.locator('.secret-error');
    await expect(error).toContainText('gist_pat');
    await expect(token).toHaveClass(/invalid/);

    // Define the secret in the General tab → the error clears and Done closes.
    await dlg.getByRole('button', { name: 'General' }).click();
    const secrets = dlg.locator('textarea');
    await secrets.fill('gist_pat: ghp_example');
    await secrets.dispatchEvent('input');
    await expect(error).toHaveCount(0);

    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toBeHidden();
  });

  test('a valid reference closes straight away', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('/easydbaccess/secrets.txt', 'gist_pat: ghp_example'));
    const dlg = await openSettings(page);
    await dlg.getByRole('button', { name: 'Gist Sync' }).click();
    const token = dlg.locator('.secret-row input');
    await token.fill('${secret:gist_pat}');
    await token.dispatchEvent('change');
    await expect(token).not.toHaveClass(/invalid/);

    await dlg.getByRole('button', { name: 'Done' }).click();
    await expect(dlg).toBeHidden();
  });
});
