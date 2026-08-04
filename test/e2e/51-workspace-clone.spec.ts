import { test, expect } from './fixtures.js';
import { createTable, waitForPanel } from './helpers.js';

/**
 * Creating a workspace asks what it starts with: everything, settings only, or
 * nothing. Before settings were workspace-scoped there was no such choice — the
 * new workspace silently shared the old one's settings, server URL and tokens.
 *
 * Each test seeds a table plus a setting, then creates a workspace and checks
 * what arrived. The app reloads into the new workspace, so the assertions read
 * the store after the navigation.
 */
test.describe('new workspace clone choice', () => {
  const NEW_WS = 'clone-target';

  async function seed(page: import('@playwright/test').Page) {
    const id = await createTable(page, 'Feed', [{ field: 'title' }]);
    await waitForPanel(page, id);
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__easydb.store.settings.upsert({
        name: 'server-sync:url',
        value: 'https://example.test',
      });
    });
  }

  /** Drive the + button through the name prompt and the choice dialog. */
  async function createWorkspace(page: import('@playwright/test').Page, pick: RegExp) {
    const dialogs = page.locator('host-dialogs');
    await page.locator('workspace-selector button[title="New workspace"]').click();
    const input = dialogs.locator('input[type="text"]').first();
    await input.waitFor();
    await input.fill(NEW_WS);
    await dialogs.getByRole('button', { name: 'OK', exact: true }).click();
    // The click navigates to ?space=<new>, so wait for the new URL and then for
    // the app hook of the freshly booted page — evaluating any earlier races the
    // navigation and hits either the old context or a page with no __easydb yet.
    await Promise.all([page.waitForURL(new RegExp(`space=${NEW_WS}`), { timeout: 15_000 }), dialogs.getByRole('button', { name: pick }).click()]);
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
      { timeout: 15_000 },
    );
  }

  /** Tables and settings of the workspace the app is currently booted into. */
  const contents = (page: import('@playwright/test').Page) =>
    page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const tables = (await ctx.store.tables.find()).filter((t: { workspaceId: string }) => t.workspaceId === ctx.workspaceId);
      const settings = await ctx.store.settings.find();
      return {
        tables: tables.map((t: { name: string }) => t.name),
        settingNames: settings.map((s: { name: string }) => s.name),
      };
    });

  test('empty workspace inherits nothing — not even the settings', async ({ page }) => {
    await seed(page);
    await createWorkspace(page, /Empty workspace/);
    const out = await contents(page);
    expect(out.tables).toEqual([]);
    expect(out.settingNames).not.toContain('server-sync:url');
  });

  test('settings only brings the settings across without the data', async ({ page }) => {
    await seed(page);
    await createWorkspace(page, /Clone settings only/);
    const out = await contents(page);
    expect(out.tables).toEqual([]);
    expect(out.settingNames).toContain('server-sync:url');
  });

  test('clone everything brings tables and settings', async ({ page }) => {
    await seed(page);
    await createWorkspace(page, /Clone everything/);
    const out = await contents(page);
    expect(out.tables).toContain('Feed');
    expect(out.settingNames).toContain('server-sync:url');
  });

  test('the source workspace keeps its own settings', async ({ page, workspaceId }) => {
    await seed(page);
    await createWorkspace(page, /Clone everything/);
    // Change the setting in the copy, then go back: the original is untouched.
    await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__easydb.store.settings.upsert({
        name: 'server-sync:url',
        value: 'https://changed.test',
      });
    });
    await page.goto(`${new URL(page.url()).pathname}?test=1&space=${workspaceId}`);
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    const url = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (await (window as any).__easydb.store.settings.findOne('server-sync:url'))?.value;
    });
    expect(url).toBe('https://example.test');
  });
});
