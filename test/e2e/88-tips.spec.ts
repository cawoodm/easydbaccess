import { test, expect } from './fixtures.js';

/**
 * The `tips` built-in shows one unseen tip on startup, remembers it, and turns
 * itself off when the user ticks "Don't show again".
 *
 * The fixture boots with `?test=1`, which suppresses the tip so it can't block
 * the other 87 specs' first click. `&tips=1` forces it back on — this spec is
 * the reason that override exists.
 */

/** The device-local list of tip ids already shown. */
async function readSeen(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => ((await (window as any).__easydb.api.settings.get('tips', 'seen')) as string[] | undefined) ?? [],
  );
}

async function gotoWithTips(page: import('@playwright/test').Page, ws: string) {
  await page.goto(`/?test=1&tips=1&space=${encodeURIComponent(ws)}`);
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
    { timeout: 15_000 },
  );
}

/** Run the palette's "Show tip" command. */
async function runShowTip(page: import('@playwright/test').Page) {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('Show tip');
  await palette.locator('.item', { hasText: 'Show tip' }).first().click();
}

test.describe('tips', () => {
  test('a normal boot (?test=1) shows no tip', async ({ page, workspaceId }) => {
    void workspaceId;
    await expect(page.locator('tips-dialog dialog')).toHaveCount(0);
  });

  test('shows a tip on startup and a different one on the next boot', async ({ page, workspaceId }) => {
    await gotoWithTips(page, workspaceId);

    const dialog = page.locator('tips-dialog dialog');
    await expect(dialog).toBeVisible();
    const first = await page.locator('tips-dialog p.tip').textContent();
    expect(first?.trim().length).toBeGreaterThan(0);
    await expect(page.locator('tips-dialog p.counter')).toContainText('Tip 1 of');

    await page.locator('tips-dialog button.primary').click();
    await expect(dialog).toBeHidden();

    // The seen list is written AFTER the dialog resolves, so wait for it rather
    // than for the dialog — navigating first can outrun the write and the
    // second boot then shows tip 1 again.
    await expect.poll(async () => (await readSeen(page)).length).toBeGreaterThan(0);

    // The seen list is device-local (localStorage), so the second boot moves on.
    await gotoWithTips(page, workspaceId);
    await expect(page.locator('tips-dialog dialog')).toBeVisible();
    await expect(page.locator('tips-dialog p.tip')).not.toHaveText(first ?? '');
    await expect(page.locator('tips-dialog p.counter')).toContainText('Tip 2 of');
  });

  test('‹ › walk the tips and every tip walked to counts as seen', async ({ page, workspaceId }) => {
    await gotoWithTips(page, workspaceId);
    const dialog = page.locator('tips-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();

    // On the first tip there is nowhere back to go.
    await expect(dialog.locator('button.nav-btn.prev')).toBeDisabled();
    const first = await dialog.locator('p.tip').textContent();

    await dialog.locator('button.nav-btn.next').click();
    await expect(dialog.locator('p.counter')).toContainText('Tip 2 of');
    await expect(dialog.locator('p.tip')).not.toHaveText(first ?? '');

    await dialog.locator('button.nav-btn.prev').click();
    await expect(dialog.locator('p.counter')).toContainText('Tip 1 of');
    await expect(dialog.locator('p.tip')).toHaveText(first ?? '');

    await dialog.locator('button.primary').click();
    await expect(dialog.locator('dialog')).toBeHidden();

    // Tips 1 and 2 were both shown, so the next boot opens on tip 3.
    await gotoWithTips(page, workspaceId);
    await expect(page.locator('tips-dialog p.counter')).toContainText('Tip 3 of');
  });

  test('"Don\'t show again" disables the plugin and no tip appears after that', async ({ page, workspaceId }) => {
    await gotoWithTips(page, workspaceId);
    await expect(page.locator('tips-dialog dialog')).toBeVisible();

    await page.locator('tips-dialog input[type="checkbox"]').check();
    await page.locator('tips-dialog button.primary').click();
    await expect(page.locator('tips-dialog dialog')).toBeHidden();

    // Same record the Plugin Manager writes, so the user can switch it back on.
    await expect
      .poll(async () =>
        page.evaluate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async () => (await (window as any).__easydb.store.plugins.findOne('builtin:tips'))?.enabled,
        ),
      )
      .toBe(false);

    // The seen list goes with it, so switching the plugin back on replays the
    // tips from the first one instead of showing nothing.
    await expect
      .poll(async () =>
        page.evaluate(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          async () => (window as any).__easydb.api.settings.get('tips', 'seen'),
        ),
      )
      .toEqual([]);

    await gotoWithTips(page, workspaceId);
    await page.waitForTimeout(300);
    await expect(page.locator('tips-dialog dialog')).toHaveCount(0);
  });

  test('the "Show tip" command shows a tip, and starts over once all are seen', async ({ page, workspaceId }) => {
    void workspaceId;
    // Booted with ?test=1, so nothing opened by itself — the command is the
    // only way a tip appears here.
    await expect(page.locator('tips-dialog dialog')).toHaveCount(0);

    await runShowTip(page);
    const dialog = page.locator('tips-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();
    await expect(dialog.locator('p.counter')).toContainText('Tip 1 of');

    // Walk to the last tip so every one of them counts as seen.
    const next = dialog.locator('button.nav-btn.next');
    while (await next.isEnabled()) await next.click();
    await dialog.locator('button.primary').click();
    await expect(dialog.locator('dialog')).toBeHidden();

    // Asking for a tip with nothing unseen left starts again at the first.
    await runShowTip(page);
    await expect(dialog.locator('dialog')).toBeVisible();
    await expect(dialog.locator('p.counter')).toContainText('Tip 1 of');
  });
});
