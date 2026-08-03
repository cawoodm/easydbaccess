import { test, expect } from './fixtures.js';

/**
 * The command palette closes on a click outside it. A modal `<dialog>` reports a
 * backdrop click as a click on the dialog element itself, so the component hit-
 * tests the pointer against the dialog's box — these tests cover both sides of
 * that box.
 */
test.describe('command palette click-outside', () => {
  test('a click on the backdrop closes the palette', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.locator('command-palette-dialog dialog');
    await expect(palette).toBeVisible();

    // Bottom-left corner: outside the centered panel, on the backdrop.
    const size = page.viewportSize()!;
    await page.mouse.click(8, size.height - 8);
    await expect(palette).toBeHidden();
  });

  test('a click inside the palette keeps it open', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.locator('command-palette-dialog dialog');
    await expect(palette).toBeVisible();

    await palette.locator('input').click();
    await expect(palette).toBeVisible();
    // The group headers are inert padding inside the box — still no close.
    const box = (await palette.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 4);
    await expect(palette).toBeVisible();
  });
});
