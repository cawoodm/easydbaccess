import { test, expect } from './fixtures.js';

/**
 * Safe mode: `?safemode` (skip URL plugins + every non-fixed built-in) and
 * `?safemode1` (skip only URL plugins) let a user recover from a
 * misbehaving/hanging plugin without losing their real per-plugin enable
 * state — both are transient boot flags, never persisted.
 *
 * The "New Table" header button is registered by the `new-table` built-in
 * (packages/renderer/src/plugins/new-table-button.ts), which is NOT
 * `meta.fixed`, so it's the attributable optional built-in used below. The
 * "Settings" header button is registered by the `settings` built-in, which
 * IS `meta.fixed: true`, so it must survive `?safemode`. The Plugin Manager
 * button is core chrome (app-shell.ts), not a plugin at all.
 */

async function gotoWithFlags(page: import('@playwright/test').Page, ws: string, flags: string) {
  await page.goto(`/?test=1&space=${encodeURIComponent(ws)}${flags}`);
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
    { timeout: 15_000 },
  );
}

test.describe('safe mode', () => {
  test('control: no flag — optional built-in UI is present', async ({ page, workspaceId }) => {
    const header = page.locator('app-shell header');
    await expect(header.getByRole('button', { name: /New Table/ })).toBeVisible();
    await expect(header.getByTitle('Workspace and plugin settings')).toBeVisible();
    await expect(header.locator('button.icon-btn[title="Add, disable, or remove plugins"]')).toBeVisible();
    void workspaceId;
  });

  test('?safemode1: built-ins still load, only URL plugins skipped', async ({
    page,
    workspaceId,
  }) => {
    await gotoWithFlags(page, workspaceId, '&safemode1');

    const header = page.locator('app-shell header');
    await expect(header.getByRole('button', { name: /New Table/ })).toBeVisible();
    await expect(header.getByTitle('Workspace and plugin settings')).toBeVisible();
  });

  test('?safemode: non-fixed built-in UI is gone, fixed built-ins + Plugin Manager still work', async ({
    page,
    workspaceId,
  }) => {
    await gotoWithFlags(page, workspaceId, '&safemode');

    const header = page.locator('app-shell header');
    // New Table is registered by a non-fixed built-in — must be absent.
    await expect(header.getByRole('button', { name: /New Table/ })).toHaveCount(0);

    // Settings is `fixed: true` — its header button and dialog must still work.
    const settingsBtn = header.getByTitle('Workspace and plugin settings');
    await expect(settingsBtn).toBeVisible();
    await settingsBtn.click();
    const settingsDialog = page.locator('settings-dialog dialog');
    await expect(settingsDialog).toBeVisible();
    await page
      .locator('settings-dialog')
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await expect(settingsDialog).toBeHidden();

    // The core Plugin Manager button (app-shell chrome, not a plugin) is
    // still reachable — the whole recovery path depends on this.
    const pluginManagerBtn = header.locator(
      'button.icon-btn[title="Add, disable, or remove plugins"]',
    );
    await expect(pluginManagerBtn).toBeVisible();
    await pluginManagerBtn.click();
    await expect(page.locator('plugin-manager-dialog dialog')).toBeVisible();
  });

  test('?safemode never persists disabled state to the plugins collection', async ({
    page,
    workspaceId,
  }) => {
    await gotoWithFlags(page, workspaceId, '&safemode');

    // Give the boot sequence (init builtins/urls + queueMicrotask loads) a
    // moment to fully settle before inspecting persisted state.
    await page.waitForTimeout(300);

    const plugins = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async () => (window as any).__easydb.store.plugins.find(),
    );
    expect(plugins).toEqual([]);
  });
});
