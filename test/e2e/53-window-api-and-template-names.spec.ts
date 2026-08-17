import { test, expect } from './fixtures.js';
import { createTable, panelDomId, waitForPanel, waitForViewTemplates } from './helpers.js';

/**
 * Two small guarantees:
 *  - `window.api` is the plugin HostApi, available to anyone who opens the
 *    console — unlike `window.__easydb`, which stays behind `?test=1`.
 *  - Two view templates cannot share a name: the list identifies a template by
 *    name, and Copy proposes "<name> copy".
 */
test.describe('window.api and template names', () => {
  test('window.api exposes the HostApi without the test flag', async ({ page, workspaceId }) => {
    await page.goto(`/?test=0&space=${encodeURIComponent(workspaceId)}`);
    // No test hook on this page, but the api shows up once the app has booted.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const api = (window as any).api;
            if (!api) return null;
            return {
              hasStore: typeof api.store?.tables?.find === 'function',
              hasDialogs: typeof api.ui?.dialogs?.toast === 'function',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              testHook: Boolean((window as any).__easydb),
            };
          }),
        { timeout: 15_000 },
      )
      .toEqual({ hasStore: true, hasDialogs: true, testHook: false });

    // It really drives the app: create a table through the console api.
    const count = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = (window as any).api;
      await api.store.tables.insert({
        id: crypto.randomUUID(),
        workspaceId: api.workspaceId(),
        name: 'FromConsole',
        code: 'fromconsole',
        columns: [{ field: 'x', label: 'x', type: 'string' }],
        view: 'table',
        updatedAt: Date.now(),
      });
      return (await api.store.tables.find()).length;
    });
    expect(count).toBeGreaterThan(0);
  });

  test('a template cannot take a name another template already has', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }]);
    await waitForPanel(page, id);
    // The count below is taken once, so the built-ins have to be all there
    // before it: a template still being seeded would land after `before` was
    // read and show up as a second addition.
    await waitForViewTemplates(page);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();

    const templateCount = () => dlg.locator('.section', { hasText: 'View templates' }).locator('li').count();
    const before = await templateCount();

    // New template, named exactly like the seeded built-in.
    await dlg.getByRole('button', { name: '+ New template' }).click();
    await dlg.locator('input[type="text"]').fill('RSS Feed');
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();

    // Blocked with an explanation, and nothing was added.
    const dialogs = page.locator('host-dialogs');
    await expect(dialogs.getByText(/already exists/)).toBeVisible();
    await dialogs.getByRole('button', { name: 'OK', exact: true }).click();

    // Still in the editor: rename to something free and it saves.
    await dlg.locator('input[type="text"]').fill('RSS Feed 2');
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(templateCount).toBe(before + 1);
  });
});
