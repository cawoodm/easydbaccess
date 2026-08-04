import { test, expect } from './fixtures.js';

/**
 * The header Connect button belongs to `connect-menu`, which lists whatever
 * backends registered a `ConnectorSpec`. Before the split, `datasette-source`
 * owned the button itself, so a second backend would have meant a second
 * "Connect" in the header.
 *
 * Import and Connect stay separate entry points — that is the point of the
 * split, so the two buttons must not merge or shadow each other.
 */

test('exactly one Connect button in the header, however many connectors exist', async ({ page }) => {
  await expect(page.getByTitle(/^Connect a live table/)).toHaveCount(1);

  // The old per-backend button is gone. Its tooltip was "Connect a live,
  // editable Datasette table"; the menu's is backend-agnostic.
  await expect(page.getByTitle(/Datasette table$/)).toHaveCount(0);
});

test('Import and Connect are separate buttons that open different dialogs', async ({ page }) => {
  const importBtn = page.getByTitle(/^Import data from a URL/);
  const connectBtn = page.getByTitle(/^Connect a live table/);
  await expect(importBtn).toHaveCount(1);
  await expect(connectBtn).toHaveCount(1);

  await importBtn.click();
  await expect(page.locator('import-dialog dialog')).toBeVisible();
  await expect(page.locator('datasette-connect-dialog dialog')).toBeHidden();
  await page.locator('import-dialog dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('import-dialog dialog')).toBeHidden();

  await connectBtn.click();
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
  await expect(page.locator('import-dialog dialog')).toBeHidden();
});

test('a single connector opens straight into its dialog, with no menu step', async ({ page }) => {
  // Datasette is the only connector today, so a menu would be a wasted click.
  // The menu appears once there is a real choice — see `openConnect`.
  await page.getByTitle(/^Connect a live table/).click();
  await expect(page.locator('anchored-menu')).toHaveCount(0);
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
});

test('the command palette can reach Connect too', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('connect a live');
  await page.keyboard.press('Enter');
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
});
