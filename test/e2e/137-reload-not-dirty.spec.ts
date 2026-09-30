import { expect, test, type Page } from '@playwright/test';
import { createTable, waitForPanel } from './helpers.js';

/**
 * A reload must not invent unsaved work.
 *
 * Saving cleared the red dot on the header Save button, and refreshing the
 * browser brought it straight back — so the app claimed there was something to
 * save when the user had done nothing at all. Worse than cosmetic: the dot is the
 * only cue for "your work is not in the file yet", and one that cries wolf on
 * every boot is one nobody reads.
 *
 * The cause was four no-op writes. `plugins/views-seed.ts` re-recorded the
 * "this built-in template has been seeded" mark for each of the four built-ins on
 * every load, whether or not it was already recorded, and the store broadcasts
 * every write it takes. Nothing else in a plain boot writes at all.
 *
 * The workspace is SAVED into a folder first, which the test used to skip. Without
 * a file there is nothing for "saved" to mean, so the old version asserted that an
 * unsaved workspace comes back clean — the opposite invariant, and the bug
 * `150-unsaved-survives-reload` now covers.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `138-first-save-survives-reload.spec.ts`.
 */

const FOLDER = 'reload-not-dirty';

test.describe.configure({ timeout: 120_000 });

async function boot(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ folder }) => {
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      (window as unknown as Record<string, unknown>)['showDirectoryPicker'] = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(folder, { create: true });
      };
    },
    { folder: FOLDER },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await ready(page);
}

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/** What the header Save button says about this workspace. */
function saveButton(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

async function isDirty(page: Page): Promise<boolean> {
  const title = await saveButton(page).getAttribute('title');
  return (title ?? '').includes('Unsaved');
}

/** The first Save of a workspace with no file: it asks for a folder, then writes. */
async function firstSaveIntoAFolder(page: Page, file: string): Promise<void> {
  await saveButton(page).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText(new RegExp(`Workspace saved to ${file.replace('.', '\\.')}`, 'i'), { timeout: 30_000 });
}

test('a reload after a save leaves the workspace clean', async ({ page }) => {
  await boot(page, 'clean');
  // The FIRST boot of a workspace really does write: it creates the workspace and
  // seeds the four built-in templates, so the dot is earned.
  const id = await createTable(page, 'Things', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await expect.poll(() => isDirty(page), { timeout: 15_000 }).toBe(true);

  await firstSaveIntoAFolder(page, 'clean.edb');
  await expect.poll(() => isDirty(page), { timeout: 15_000 }).toBe(false);

  // The second boot has nothing to do, and the file holds everything the browser
  // does. Only a WRITE during boot can dirty it again — which is what four no-op
  // seed marks used to do.
  await page.reload();
  await ready(page);
  await waitForPanel(page, id);

  await expect.poll(() => isDirty(page), { timeout: 20_000 }).toBe(false);
});
