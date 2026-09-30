import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

/**
 * Two workspaces that read as one, and a question about a third thing.
 *
 * The report: the list showed "PowerPlants" twice, both saying `powerplants.edb`
 * when hovered, and deleting one of them asked "Delete the workspace "Simon"?".
 * Three separate spellings of one workspace, none of which agreed.
 *
 * - A workspace has a TITLE and a technical NAME. Everything a user reads shows
 *   the title; the delete prompt quoted the name.
 * - The FILE is what tells two same-titled workspaces apart, in a tooltip — and it
 *   cannot, when both of them came out of the SAME file. That is a `.edb` holding
 *   two workspaces, which the rule forbids and nothing was checking for.
 */

const options = (page: Page) => page.locator('app-shell workspace-selector select option');

/** Plant a device-local folder index. No folder grant needed — this is a cache. */
async function plantIndex(page: Page, workspaces: { id: string; name: string; title?: string; file: string }[]) {
  await page.evaluate((list) => {
    localStorage.setItem('eda:folderIndex', JSON.stringify({ folder: 'demo-folder', at: Date.now(), workspaces: list }));
    window.dispatchEvent(new CustomEvent('easydb:folder-index-changed'));
  }, workspaces);
}

test('two workspaces out of one file are told apart in the list', async ({ page }) => {
  // What a `.edb` written before v0.0.427 looks like to a scan: one file, two
  // workspaces in it, both carrying the same title.
  await plantIndex(page, [
    { id: 'powerplants', title: 'PowerPlants', file: 'powerplants.edb' },
    { id: 'simon', title: 'PowerPlants', file: 'powerplants.edb' },
  ]);

  const twins = options(page).filter({ hasText: 'PowerPlants' });
  await expect(twins).toHaveCount(2);
  // The technical name is the qualifier, because that is what the delete prompt
  // and `?space=` both speak. Before the fix both rows read "PowerPlants".
  await expect(twins.nth(0)).toHaveText('PowerPlants (powerplants)');
  await expect(twins.nth(1)).toHaveText('PowerPlants (simon)');
  // The tooltip is no help here, which is the whole reason the text had to change.
  await expect(twins.nth(0)).toHaveAttribute('title', 'powerplants.edb');
  await expect(twins.nth(1)).toHaveAttribute('title', 'powerplants.edb');
});

test('one workspace in two files is ONE row, and it is the file named after it', async ({ page }) => {
  // The same workspace in two files used to be listed twice, so that declining the
  // conflict prompt left both reachable. The id is the identity now — it is also
  // the file name — so the list holds one row per id, and the copy it stands for is
  // the file Save writes and Open reads the id back out of.
  await plantIndex(page, [
    { id: 'sales', title: 'Sales', file: 'backup.edb' },
    { id: 'sales', title: 'Sales', file: 'sales.edb' },
  ]);

  const rows = options(page).filter({ hasText: 'Sales' });
  await expect(rows).toHaveCount(1);
  await expect(rows.nth(0)).toHaveText('Sales');
  await expect(rows.nth(0)).toHaveAttribute('title', 'sales.edb');
});

test('the delete prompt names the workspace the way the header does', async ({ page, workspaceId }) => {
  const header = page.locator('app-shell header');
  await header.getByTitle('Workspace and plugin settings').click();
  const settings = page.locator('settings-dialog');
  const titleInput = settings.getByPlaceholder('easyDBAccess');
  await titleInput.fill('Power Plants');
  await titleInput.blur();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();

  await page.locator('workspace-selector').getByTitle('Delete this workspace').click();
  const dialogs = page.locator('host-dialogs');
  // The title first, because that is what the list and the header say — and the
  // technical name after it, because two workspaces may share one title and the
  // user is about to delete data. It used to show the technical name alone, which
  // is a word that appears nowhere else on screen.
  await expect(dialogs.getByText(`Delete the workspace "Power Plants" (${workspaceId})?`)).toBeVisible();
  await dialogs.getByRole('button', { name: 'No', exact: true }).click();
});

test('Switch workspace offers two same-titled workspaces as two answers', async ({ page }) => {
  // Two OTHER workspaces carrying one title. The picker reported the LABEL back
  // and looked the workspace up by it, so the second of two identical lines could
  // never be chosen — whichever one you clicked opened the first.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    for (const id of ['twin-a', 'twin-b']) await ctx.store.workspaces.insert({ id, name: id, createdAt: Date.now(), pluginUrls: [], title: 'Twin' });
  });

  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('workspace');
  await palette.locator('.item', { hasText: 'Switch workspace' }).first().click();

  const dialogs = page.locator('host-dialogs');
  await expect(dialogs.getByRole('button', { name: 'Twin (twin-a)', exact: true })).toBeVisible();
  await expect(dialogs.getByRole('button', { name: 'Twin (twin-b)', exact: true })).toBeVisible();
  // And nothing left saying only "Twin", which would be a line that cannot be
  // told from its neighbour.
  await expect(dialogs.getByRole('button', { name: 'Twin', exact: true })).toHaveCount(0);
});
