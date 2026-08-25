import { test, expect, type Page } from './fixtures.js';

/**
 * The `new-plugins` built-in mentions catalog plugins the user has never had, once
 * each, and offers to open the Plugin Manager.
 *
 * The fixture boots with `?test=1`, which suppresses the prompt so it cannot block
 * the other specs' first click. `&plugins=1` forces it back on — this spec is the
 * reason that override exists, exactly as `?tips=1` is for `88-tips.spec.ts`.
 *
 * The catalog under test is the app's own `public/plugins/catalog.json`: three demo
 * plugins, none of them installed by default.
 */

/** The device-local list of catalog URLs already mentioned. */
async function readMentioned(page: Page): Promise<string[]> {
  return page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async () => ((await (window as any).__easydb.api.settings.get('new-plugins', 'mentioned')) as string[] | undefined) ?? [],
  );
}

async function gotoWithPrompt(page: Page, ws: string) {
  await page.goto(`/?test=1&plugins=1&space=${encodeURIComponent(ws)}`);
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
    { timeout: 15_000 },
  );
}

/** Run the palette's "Show available plugins" command. */
async function runShowAvailable(page: Page) {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('Show available plugins');
  await palette.locator('.item', { hasText: 'Show available plugins' }).first().click();
}

const prompt = (page: Page) => page.locator('host-dialogs').getByText(/you have never installed/);

test.describe('new plugins', () => {
  // The fixture boots the app once, and half of these boot it again to prove the
  // second boot is quiet. Two boots plus a settings write do not fit the default 30s.
  test.describe.configure({ timeout: 120_000 });

  test('a normal boot (?test=1) says nothing', async ({ page, workspaceId }) => {
    void workspaceId;
    await expect(prompt(page)).toHaveCount(0);
  });

  test('names what is new, then never asks again', async ({ page, workspaceId }) => {
    await gotoWithPrompt(page, workspaceId);

    // Every demo plugin in the shipped catalog, named — a count alone would not
    // tell the user whether it is worth opening the dialog for.
    await expect(prompt(page)).toBeVisible({ timeout: 20_000 });
    const dialog = page.locator('host-dialogs');
    await expect(dialog).toContainText('Email Renderer');
    await expect(dialog).toContainText('Header Clock');

    // Declining is an answer, so it counts as having been told. The list is written
    // BEFORE the question, so this is already true while the dialog is open.
    await expect.poll(async () => (await readMentioned(page)).length, { timeout: 10_000 }).toBe(3);
    await dialog.getByRole('button', { name: 'No', exact: true }).click();
    await expect(prompt(page)).toHaveCount(0);

    // The point of the whole feature: the second boot is quiet.
    await gotoWithPrompt(page, workspaceId);
    await page.waitForTimeout(1_000);
    await expect(prompt(page)).toHaveCount(0);
  });

  test('a mention survives the device layer being wiped', async ({ page, workspaceId }) => {
    // The device list is `localStorage`, so it is per ORIGIN: the same workspace on
    // another dev server, on the published site, or after site data is cleared, had
    // never been told anything and asked about the same plugin again. So the mention
    // is written to the workspace's own settings too, and read as a union.
    await gotoWithPrompt(page, workspaceId);
    await expect(prompt(page)).toBeVisible({ timeout: 20_000 });
    await expect.poll(async () => (await readMentioned(page)).length, { timeout: 10_000 }).toBe(3);
    await page.locator('host-dialogs').getByRole('button', { name: 'No', exact: true }).click();

    // Everything the device knew, gone — which is what another origin looks like
    // from the workspace's point of view.
    await page.evaluate(() => localStorage.removeItem('/easydbaccess/settings.json'));
    expect(await readMentioned(page)).toEqual([]);

    await gotoWithPrompt(page, workspaceId);
    await page.waitForTimeout(1_000);
    await expect(prompt(page)).toHaveCount(0);
  });

  test('saying yes opens the Plugin Manager', async ({ page, workspaceId }) => {
    await gotoWithPrompt(page, workspaceId);
    await expect(prompt(page)).toBeVisible({ timeout: 20_000 });

    await page.locator('host-dialogs').getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(page.locator('plugin-manager-dialog dialog')).toBeVisible();
    // And the plugins it was talking about are in the list it opened.
    await expect(page.locator('plugin-manager-dialog dialog').getByText('Header Clock')).toBeVisible();
  });

  test('a plugin already installed is not offered', async ({ page, workspaceId }) => {
    // Installed by URL, which is what `pluginUrls` holds. No need to go through the
    // dialog: the filter reads the workspace, and this is what the dialog writes.
    await page.evaluate(async (ws) => {
      const url = new URL('/plugins/header-clock.js', location.origin).toString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__easydb.store.workspaces.patch(ws, { pluginUrls: [url] });
    }, workspaceId);

    await gotoWithPrompt(page, workspaceId);
    await expect(prompt(page)).toBeVisible({ timeout: 20_000 });

    const dialog = page.locator('host-dialogs');
    await expect(dialog).toContainText('Email Renderer');
    await expect(dialog).not.toContainText('Header Clock');
    // Two of the three, so the sentence counts what it names.
    await expect(dialog).toContainText('2 plugins');
  });

  test('the command asks on purpose, even after the boot prompt was declined', async ({ page, workspaceId }) => {
    void workspaceId;
    // Booted with ?test=1, so nothing opened by itself.
    await expect(prompt(page)).toHaveCount(0);

    await runShowAvailable(page);
    // Asked for deliberately, so the mentioned list is ignored — the same reasoning
    // as "Show tip", which starts the tour over rather than saying nothing.
    await expect(prompt(page)).toBeVisible({ timeout: 20_000 });
    await page.locator('host-dialogs').getByRole('button', { name: 'No', exact: true }).click();

    await runShowAvailable(page);
    await expect(prompt(page)).toBeVisible({ timeout: 20_000 });
  });
});
