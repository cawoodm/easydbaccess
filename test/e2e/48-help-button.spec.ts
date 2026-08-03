import { test, expect } from './fixtures.js';

/**
 * The header Help (?) button is a plain anchor (not a button + window.open)
 * so middle-click / ctrl-click / "copy link address" work for free. Assert
 * its attributes only — never navigate to GitHub, so the suite stays
 * offline and fast.
 */
test.describe('help button', () => {
  test('header has a Help link to the user guide, opening in a new tab', async ({ page }) => {
    const header = page.locator('app-shell header');
    // Target by title/aria-label rather than `.icon-btn` — that class is
    // shared by the search and Plugin Manager buttons too (see the known
    // strict-mode failures in 09-ui-niceties.spec.ts), so an unqualified
    // `.icon-btn` locator would be ambiguous.
    const helpLink = header.locator('a[title="Help — open the user guide"]');

    await expect(helpLink).toBeVisible();
    await expect(helpLink).toHaveAttribute(
      'href',
      'https://github.com/cawoodm/easydbaccess/blob/main/docs/help/INDEX.md',
    );
    await expect(helpLink).toHaveAttribute('target', '_blank');
    await expect(helpLink).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(helpLink).toHaveAttribute('aria-label', 'Help — open the user guide');
  });
});
