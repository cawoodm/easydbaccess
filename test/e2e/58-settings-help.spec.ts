import { test, expect } from './fixtures.js';

/**
 * A settings field can carry a longer explanation plus a link, behind an (i) icon
 * next to its label. The GitHub token field uses it: the help says which scope to
 * grant and links straight to GitHub's token page.
 */
test('a field with help shows it behind the (i) icon, with its link', async ({ page }) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Gist Sync' }).click();

  // Closed to start with — help is on demand, not a wall of text.
  await expect(dlg.locator('.help-panel')).toHaveCount(0);

  const helpBtn = dlg.getByRole('button', { name: 'Help for GitHub token (PAT)' });
  await expect(helpBtn).toBeVisible();
  await helpBtn.click();

  const panel = dlg.locator('.help-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('gist');
  const link = panel.getByRole('link');
  await expect(link).toHaveAttribute('href', /github\.com\/settings\/tokens\/new/);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveText('Create a token on GitHub');

  // The icon toggles it shut again.
  await helpBtn.click();
  await expect(dlg.locator('.help-panel')).toHaveCount(0);
});

test('a field without help has no (i) icon', async ({ page }) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await dlg.getByRole('button', { name: 'Gist Sync' }).click();
  // "Gist ID" carries only a one-line description.
  await expect(dlg.getByRole('button', { name: 'Help for Gist ID' })).toHaveCount(0);
});
