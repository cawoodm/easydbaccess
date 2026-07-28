import { test, expect } from './fixtures.js';

/**
 * TODO § Dialogs
 * - choice(): vertical button list, returns the chosen label
 * - prompt(): replacement for window.prompt
 * - alert(): replacement for window.alert
 * - toast: non-modal notification (covered here too — same dialog system)
 * - confirm: replacement for window.confirm (built on top of choice)
 *
 * Scope every locator to <host-dialogs> so it doesn't accidentally match the
 * header/footer buttons that also live in the page.
 */

test.describe('dialogs', () => {
  test('alert resolves on OK', async ({ page }) => {
    const dialog = page.locator('host-dialogs');
    const result = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.alert('Hello from test', 'Smoke').then(() => 'resolved');
    });
    await expect(dialog.getByText('Hello from test')).toBeVisible();
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    expect(await result).toBe('resolved');
  });

  test('confirm returns true on Yes, false on No', async ({ page }) => {
    const dialog = page.locator('host-dialogs');

    const yesResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.confirm('Really?', 'Confirm');
    });
    await expect(dialog.getByText('Really?')).toBeVisible();
    await dialog.getByRole('button', { name: 'Yes', exact: true }).click();
    expect(await yesResult).toBe(true);

    const noResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.confirm('Skip?');
    });
    await expect(dialog.getByText('Skip?')).toBeVisible();
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    expect(await noResult).toBe(false);
  });

  test('prompt returns the entered string, null on Cancel', async ({ page }) => {
    const dialog = page.locator('host-dialogs');

    const okResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.prompt('Name?', 'default-value', 'Prompt');
    });
    const input = dialog.locator('input[type="text"]').first();
    await input.waitFor();
    await input.fill('alice');
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    expect(await okResult).toBe('alice');

    const cancelResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.prompt('Name?');
    });
    await dialog.locator('input[type="text"]').first().waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await cancelResult).toBeNull();
  });

  test('choice returns the chosen label, null on Cancel', async ({ page }) => {
    const dialog = page.locator('host-dialogs');

    const pickResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.choice('Pick one', ['Append', 'Overwrite'], 'Choice');
    });
    await expect(dialog.getByRole('button', { name: 'Append', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Overwrite', exact: true }).click();
    expect(await pickResult).toBe('Overwrite');

    const cancelResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.choice('Pick one', ['Alpha', 'Bravo']);
    });
    await expect(dialog.getByRole('button', { name: 'Alpha', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await cancelResult).toBeNull();
  });

  test('choice defaults to the first option: primary style, focused, Enter submits', async ({
    page,
  }) => {
    const dialog = page.locator('host-dialogs');

    const enterResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.choice('Pick one', ['Append', 'Overwrite']);
    });
    const first = dialog.getByRole('button', { name: 'Append', exact: true });
    const second = dialog.getByRole('button', { name: 'Overwrite', exact: true });
    await expect(first).toBeVisible();

    // First option is the focused default and carries the primary style.
    await expect(first).toBeFocused();
    await expect(first).toHaveClass(/primary/);
    await expect(second).not.toHaveClass(/primary/);

    await page.keyboard.press('Enter');
    expect(await enterResult).toBe('Append');

    // Regression guard: focusing the SECOND button and pressing Enter must
    // resolve with that button's own value, not silently fall through to
    // the form's default (first) option.
    const secondResult = page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      return api.ui.dialogs.choice('Pick one', ['Append', 'Overwrite']);
    });
    await dialog.getByRole('button', { name: 'Append', exact: true }).waitFor();
    const secondBtn = dialog.getByRole('button', { name: 'Overwrite', exact: true });
    await secondBtn.focus();
    await page.keyboard.press('Enter');
    expect(await secondResult).toBe('Overwrite');
  });

  test('toast appears non-modally and auto-dismisses', async ({ page }) => {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).__easydb.api;
      api.ui.dialogs.toast('Saved', { kind: 'success', title: 'OK', durationMs: 600 });
    });
    const toastHost = page.locator('toast-host');
    await expect(toastHost.getByText('Saved')).toBeVisible();
    // Toast is non-modal: the header must still be reachable.
    await expect(page.locator('app-shell header')).toBeVisible();
    // And it auto-dismisses.
    await expect(toastHost.getByText('Saved')).toBeHidden({ timeout: 3000 });
  });
});
