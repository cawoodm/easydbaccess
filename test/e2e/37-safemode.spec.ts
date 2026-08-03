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

/**
 * Safe mode opens the Plugin Manager by itself (that is the whole point of the
 * flag). It is a modal dialog, so anything testing the shell underneath has to
 * dismiss it first.
 */
async function closeAutoPluginManager(page: import('@playwright/test').Page) {
  const dlg = page.locator('plugin-manager-dialog dialog');
  await expect(dlg).toBeVisible();
  await page.locator('plugin-manager-dialog .header-actions button.ghost').click();
  await expect(dlg).toBeHidden();
}

test.describe('safe mode', () => {
  test('control: no flag — optional built-in UI is present', async ({ page, workspaceId }) => {
    const header = page.locator('app-shell header');
    await expect(header.getByRole('button', { name: /New Table/ })).toBeVisible();
    await expect(header.getByTitle('Workspace and plugin settings')).toBeVisible();
    await expect(
      header.locator('button.icon-btn[title="Add, disable, or remove plugins"]'),
    ).toBeVisible();
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
    await closeAutoPluginManager(page);

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

  test('both safe-mode flags open the Plugin Manager on boot; no flag does not', async ({
    page,
    workspaceId,
  }) => {
    const dlg = page.locator('plugin-manager-dialog dialog');
    // Control: a normal boot must not open anything.
    await expect(dlg).toBeHidden();

    await gotoWithFlags(page, workspaceId, '&safemode');
    await expect(dlg).toBeVisible();

    await gotoWithFlags(page, workspaceId, '&safemode1');
    await expect(dlg).toBeVisible();
  });

  test('the Plugin Manager marks safe-mode-skipped plugins instead of showing them enabled', async ({
    page,
    workspaceId,
  }) => {
    await gotoWithFlags(page, workspaceId, '&safemode');
    // No click needed — safe mode opens the manager itself.
    const dlg = page.locator('plugin-manager-dialog');
    await expect(dlg.locator('dialog')).toBeVisible();

    // A banner explains why nothing is running — the toggles alone used to say
    // "enabled" for every plugin, which is what made this confusing.
    await expect(dlg.locator('p.safemode')).toContainText('Safe mode is on');

    // Every plugin that WOULD have loaded is marked skipped. That's the rows
    // carrying an enable toggle (built-in or installed) — a catalog entry that
    // isn't installed was never going to load, so it isn't "skipped".
    const toggleable = dlg.locator('.row:has(input[type="checkbox"])');
    const toggleableCount = await toggleable.count();
    expect(toggleableCount).toBeGreaterThan(0);
    await expect(dlg.locator('.row.skipped')).toHaveCount(toggleableCount);
    await expect(dlg.locator('.row:not(:has(input[type="checkbox"])).skipped')).toHaveCount(0);
    await expect(toggleable.first().locator('.row-skipped')).toBeVisible();

    // ...and reads as Disabled to the status filter, since it is not running.
    // "Enabled" therefore matches only the fixed built-ins, which are the two
    // plugins safe mode still runs.
    await dlg.getByRole('button', { name: /Enabled/ }).click();
    // Fixed rows are the ones carrying a lock icon instead of a toggle.
    const fixedRows = dlg.locator('.row:has(.lock-icon)');
    expect(await fixedRows.count()).toBeGreaterThan(0);
    await expect(dlg.locator('.row')).toHaveCount(await fixedRows.count());
    await expect(dlg.locator('.row.skipped')).toHaveCount(0);

    // The saved setting is untouched — the toggle still shows the plugin as on.
    await dlg.getByRole('button', { name: /Enabled/ }).click();
    await dlg.getByRole('button', { name: /Enabled/ }).click();
    await expect(toggleable.first().locator('input[type="checkbox"]')).toBeChecked();
  });

  test('without a flag nothing is marked skipped', async ({ page, workspaceId }) => {
    void workspaceId;
    await page
      .locator('app-shell header button.icon-btn[title="Add, disable, or remove plugins"]')
      .click();
    const dlg = page.locator('plugin-manager-dialog');
    await expect(dlg.locator('dialog')).toBeVisible();
    await expect(dlg.locator('p.safemode')).toHaveCount(0);
    await expect(dlg.locator('.row.skipped')).toHaveCount(0);
    // Optional built-ins are running, so they read as Enabled.
    await dlg.getByRole('button', { name: /Enabled/ }).click();
    expect(await dlg.locator('.row').count()).toBeGreaterThan(0);
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
