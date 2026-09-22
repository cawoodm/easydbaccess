import { test, expect } from './fixtures.js';
import { openConnect } from './helpers.js';

/**
 * The header Connect button belongs to `connect-menu`, which lists whatever
 * backends registered a `ConnectorSpec`. Before the split, `datasette-source`
 * owned the button itself, so a second backend would have meant a second
 * "Connect" in the header.
 *
 * Import and Connect stay separate entry points — that is the point of the
 * split, so the two buttons must not merge or shadow each other.
 *
 * Since Local Data was added there are two connectors, in two halves, so
 * Connect asks which half first. What used to be "one connector, no menu" is
 * now "one connector PER HALF, no second menu" — the shape below.
 */

test('exactly one Connect button in the header, however many connectors exist', async ({ page }) => {
  await expect(page.getByTitle(/^Connect data/)).toHaveCount(1);

  // The old per-backend button is gone. Its tooltip was "Connect a live,
  // editable Datasette table"; the menu's is backend-agnostic.
  await expect(page.getByTitle(/Datasette table$/)).toHaveCount(0);
});

test('Import and Connect are separate buttons that open different dialogs', async ({ page }) => {
  const importBtn = page.getByTitle(/^Import data from a URL/);
  const connectBtn = page.getByTitle(/^Connect data/);
  await expect(importBtn).toHaveCount(1);
  await expect(connectBtn).toHaveCount(1);

  await importBtn.click();
  await expect(page.locator('import-dialog dialog')).toBeVisible();
  await expect(page.locator('datasette-connect-dialog dialog')).toBeHidden();
  await page.locator('import-dialog dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('import-dialog dialog')).toBeHidden();

  await openConnect(page, 'Remote System');
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
  await expect(page.locator('import-dialog dialog')).toBeHidden();
});

test('Connect asks local or remote, and nothing more', async ({ page }) => {
  await page.getByTitle(/^Connect data/).click();
  const menu = page.locator('anchored-menu');
  await expect(menu).toBeVisible();
  // Exactly two: the halves. Not the backends — those come after, and only
  // when a half holds more than one.
  await expect(menu.getByText('Local Data', { exact: true })).toBeVisible();
  await expect(menu.getByText('Remote System', { exact: true })).toBeVisible();
});

test('a half with one connector opens straight into its dialog, with no second menu', async ({ page }) => {
  // Datasette is the only REMOTE connector today, so a second menu would be a
  // wasted click. It appears once a half holds a real choice — see `openScope`.
  await openConnect(page, 'Remote System');
  await expect(page.locator('anchored-menu')).toBeHidden();
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
});

test('the command palette can reach Connect too', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('connect data');
  await page.keyboard.press('Enter');

  // No anchor from the palette, so the halves come as a modal choice rather
  // than an anchored menu — the fallback in `openConnect`.
  const choice = page.locator('host-dialogs dialog');
  await expect(choice).toBeVisible();
  await choice.getByRole('button', { name: 'Remote System' }).click();
  await expect(page.locator('datasette-connect-dialog dialog')).toBeVisible();
});
