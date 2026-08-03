import { test, expect } from './fixtures.js';

test('the header “>” button opens the command palette', async ({ page }) => {
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeHidden();

  await page.locator('app-shell header').getByTitle(/open the command palette/i).click();

  await expect(palette).toBeVisible();
});
