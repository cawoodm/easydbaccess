import { test, expect } from './fixtures.js';

/**
 * On a phone-sized viewport, dialogs go full-screen (edge to edge) instead of
 * overflowing their fixed min-width. Driven by a shared media query in
 * dialog-chrome.ts, so one dialog is a good proxy for all of them.
 */
test('dialogs fill the screen on a phone viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });

  // The Import dialog has its own min-width:420px / max-width:560px — wider than
  // the 375px viewport — so it's a clear test of the responsive override.
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();

  const box = await dlg.boundingBox();
  expect(box).not.toBeNull();
  // Fills the full width and height (allow a 1px rounding slack).
  expect(box!.width).toBeGreaterThanOrEqual(374);
  expect(box!.height).toBeGreaterThanOrEqual(666);
  // Pinned to the top-left corner (no centering margin).
  expect(box!.x).toBeLessThanOrEqual(1);
  expect(box!.y).toBeLessThanOrEqual(1);

  // And it does NOT overflow the viewport horizontally.
  expect(box!.width).toBeLessThanOrEqual(376);
});

test('a full-screen dialog actually closes on a phone viewport (not stuck visible)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });

  // Regression: the mobile full-screen rule once forced `display:flex` on ALL
  // dialogs, overriding the UA `dialog:not([open]){display:none}` — so a closed
  // dialog stayed visible and blocked the whole UI. Scoping it to `dialog[open]`
  // fixes it: closing must hide the dialog and leave the app interactive.
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();

  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect(dlg).toBeHidden(); // the <dialog> is display:none again

  // The UI is usable again — reopening works (a stuck modal backdrop would
  // swallow this click).
  await page.getByTitle('Import data from a URL').click();
  await expect(dlg).toBeVisible();
});
