import { test, expect } from './fixtures.js';

/**
 * The palette launcher is a SECONDARY header button: an icon with no label,
 * sitting with the other utility actions on the far right, rather than a primary
 * call to action beside New Table and Import.
 */
test('the header “>” button opens the command palette', async ({ page }) => {
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeHidden();

  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();

  await expect(palette).toBeVisible();
});

test('it is an icon-only secondary button on the far right', async ({ page }) => {
  const header = page.locator('app-shell header');
  const btn = header.getByTitle(/open the command palette/i);

  await expect(btn).toHaveClass(/icon-btn/);
  // Icon only: no "Commands" text next to it.
  await expect(btn).toHaveText('chevron_right');
  // Named for a screen reader even though the label is not drawn.
  await expect(btn).toHaveAttribute('aria-label', /command palette/i);

  // On the utility side of the header, after every primary call to action.
  // Not pinned relative to Settings: secondary buttons render in registration
  // order (`ButtonSpec.order` is documented but not yet honoured), so which of
  // them comes first is not something this behaviour promises.
  const order = await header.evaluate((h) => {
    const all = [...h.querySelectorAll('button, a')];
    const idx = (pred: (el: Element) => boolean) => all.findIndex(pred);
    return {
      lastPrimary: all.reduce((last, el, i) => (el.classList.contains('primary') ? i : last), -1),
      palette: idx((el) => /open the command palette/i.test(el.getAttribute('title') ?? '')),
    };
  });
  expect(order.lastPrimary).toBeGreaterThanOrEqual(0);
  expect(order.palette).toBeGreaterThan(order.lastPrimary);
});
