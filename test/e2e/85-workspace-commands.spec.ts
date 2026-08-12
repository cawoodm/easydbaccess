import { test, expect } from './fixtures.js';
import { addRow, chooseSimpleStorage, createTable, waitForPanel } from './helpers.js';

/**
 * Switching, adding and deleting a workspace are palette commands, not just a
 * dropdown and a "+" in the header. Deleting is the new one: there was no way to
 * remove a workspace at all, and it has to take EVERYTHING with it — a leftover
 * settings row would be inherited by the next workspace created under the same
 * name, because a workspace id is its slugified name.
 */

/** Open the palette, type `query`, and run the entry titled `title`. */
async function runCommand(page: import('@playwright/test').Page, query: string, title: string) {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(query);
  await palette.locator('.item', { hasText: title }).first().click();
}

/** Wait out a workspace navigation and the boot of the page it lands on. */
async function bootedAt(page: import('@playwright/test').Page, space: RegExp | string) {
  await page.waitForURL(typeof space === 'string' ? new RegExp(`space=${space}`) : space, { timeout: 15_000 });
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
    { timeout: 15_000 },
  );
}

/** The workspace the app is booted into, with its tables and setting names. */
function currentWorkspace(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const all = await ctx.store.tables.find();
    const settings = await ctx.store.settings.find();
    return {
      id: ctx.workspaceId as string,
      mine: (all as Array<{ name: string; workspaceId: string }>).filter((t) => t.workspaceId === ctx.workspaceId).map((t) => t.name),
      orphaned: (all as Array<{ workspaceId: string }>).map((t) => t.workspaceId),
      settingNames: (settings as Array<{ name: string }>).map((s) => s.name),
    };
  });
}

/** Answer the name prompt, then the "what should it start with?" choice. */
async function createWorkspace(page: import('@playwright/test').Page, name: string) {
  const dialogs = page.locator('host-dialogs');
  const input = dialogs.locator('input[type="text"]').first();
  await input.waitFor();
  await input.fill(name);
  await dialogs.getByRole('button', { name: 'OK', exact: true }).click();
  await chooseSimpleStorage(page);
  // The pick navigates, so wait for the new URL and the booted page together.
  await Promise.all([bootedAt(page, name), dialogs.getByRole('button', { name: /Empty workspace/ }).click()]);
}

test('the palette carries switch, new and delete', async ({ page }) => {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('workspace');

  await expect(palette.locator('.item', { hasText: 'Switch workspace' })).toBeVisible();
  await expect(palette.locator('.item', { hasText: 'New workspace' })).toBeVisible();
  await expect(palette.locator('.item', { hasText: 'Delete workspace' })).toBeVisible();
  await expect(palette.locator('.group-head', { hasText: 'Workspace' })).toBeVisible();
});

test('New workspace creates one and opens it', async ({ page }) => {
  await createTable(page, 'Feed', [{ field: 'title' }]);

  await runCommand(page, 'workspace', 'New workspace');
  await createWorkspace(page, 'made-by-command');

  const out = await currentWorkspace(page);
  expect(out.id).toBe('made-by-command');
  expect(out.mine).toEqual([]); // "Empty workspace" inherits nothing
});

test('Switch workspace opens the one you pick', async ({ page, workspaceId }) => {
  await runCommand(page, 'workspace', 'New workspace');
  await createWorkspace(page, 'second-space');

  // Back to where we started, chosen by name from the switch list.
  await runCommand(page, 'workspace', 'Switch workspace');
  const dialogs = page.locator('host-dialogs');
  await Promise.all([bootedAt(page, workspaceId), dialogs.getByRole('button', { name: workspaceId }).click()]);

  expect((await currentWorkspace(page)).id).toBe(workspaceId);
});

test('Switch workspace says so when there is nowhere to switch to', async ({ page }) => {
  await runCommand(page, 'workspace', 'Switch workspace');
  await expect(page.locator('toast-host').getByText('This is the only workspace.')).toBeVisible();
});

test('Delete workspace takes the tables, the rows and the settings with it', async ({ page, workspaceId }) => {
  // Seed the workspace that is about to be deleted: a table with a row, and a
  // setting — the thing a re-created workspace used to inherit.
  const tableId = await createTable(page, 'Feed', [{ field: 'title' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { title: 'Only row' });
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.store.settings.upsert({ name: 'server-sync:url', value: 'https://example.test' });
  });

  // A second workspace to survive the delete and be reloaded into.
  await runCommand(page, 'workspace', 'New workspace');
  await createWorkspace(page, 'survivor');

  // Delete the seeded one from here — it is not the active workspace, so this
  // path must NOT navigate.
  await runCommand(page, 'workspace', 'Delete workspace');
  const dialogs = page.locator('host-dialogs');
  await dialogs.getByRole('button', { name: workspaceId }).click();
  await expect(dialogs.getByText(/1 table, 1 row/)).toBeVisible();
  // `confirm` is a two-choice dialog — Yes / No, not OK / Cancel.
  await dialogs.getByRole('button', { name: 'Yes', exact: true }).click();

  await expect(page.locator('toast-host').getByText(/Deleted/)).toBeVisible();
  const after = await currentWorkspace(page);
  expect(after.id).toBe('survivor');
  expect(after.orphaned).not.toContain(workspaceId); // its table is gone

  // Its rows went with it, and re-creating the workspace under the same name
  // (same id) starts clean instead of inheriting the old settings.
  const rows = await page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (id) => (window as any).__easydb.store.rows(id).find(),
    tableId,
  );
  expect(rows).toEqual([]);

  await page.goto(`${new URL(page.url()).pathname}?test=1&space=${workspaceId}`);
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
    { timeout: 15_000 },
  );
  const reborn = await currentWorkspace(page);
  expect(reborn.mine).toEqual([]);
  expect(reborn.settingNames).not.toContain('server-sync:url');
});

test('deleting the only workspace puts an empty one in its place', async ({ page }) => {
  await createTable(page, 'Feed', [{ field: 'title' }]);

  await runCommand(page, 'workspace', 'Delete workspace');
  const dialogs = page.locator('host-dialogs');
  // One workspace ⇒ no "which one?" question, straight to the confirm.
  await expect(dialogs.getByText(/only workspace/)).toBeVisible();
  await Promise.all([bootedAt(page, /\?(?!.*space=)/), dialogs.getByRole('button', { name: 'Yes', exact: true }).click()]);

  const out = await currentWorkspace(page);
  expect(out.mine).toEqual([]);
});
