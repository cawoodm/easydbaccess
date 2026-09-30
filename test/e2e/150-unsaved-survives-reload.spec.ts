import { expect, test, type Page } from '@playwright/test';
import { createTable, waitForPanel } from './helpers.js';

/**
 * Unsaved work stays unsaved across a reload, and Open must not write over it.
 *
 * Two halves of one report. Change some data, and the Save button shows its red
 * dot. Refresh the page: the changes are still on screen — they are in the OPFS
 * copy — but the dot is gone, and then Open the workspace file and they are gone
 * too, with nothing said.
 *
 * - **The dot** came from `AutosavePolicy` alone, a closure variable rebuilt on
 *   every load and starting at false. The stamp in `localStorage` knew perfectly
 *   well that this copy held changes the file did not (`markLocalChanges` writes
 *   it on every store change), and nothing read it back. `holdsUnsavedWork` is
 *   what the policy is now seeded from.
 * - **The loss** was `edb-file.ts`'s `open()` calling `placeForNextBoot`
 *   unconditionally, which imports the file's bytes over this browser's database
 *   of that name. Every other route that can replace a copy asks first
 *   (`settleTwoCopies`); this one did not.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `138-first-save-survives-reload.spec.ts`.
 */

const FOLDER = 'unsaved-survives';

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

/**
 * Save until nothing is outstanding.
 *
 * A panel writes its geometry on a debounce, so the Save that answers the first
 * click is often followed by one more write and the dot comes straight back.
 * Autosave is off, so only another Save clears it — a poll on its own would wait
 * for ever. Same reason `123-folder-file-refresh` has a `settleClean`.
 */
async function settleClean(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await isDirty(page))) return;
    await saveButton(page).click();
    await expect(page.locator('toast-host')).toContainText(/Workspace saved to/i, { timeout: 30_000 });
    await page.waitForTimeout(1500);
  }
  expect(await isDirty(page), 'the workspace never settled: this tab keeps writing').toBe(false);
}

async function tableNames(page: Page): Promise<string[]> {
  try {
    return (
      await page.evaluate(async () => {
        const app = (window as unknown as { __easydb?: { store: { tables: { find(): Promise<{ name: string }[]> } } } }).__easydb;
        if (!app) return [];
        return (await app.store.tables.find()).map((t) => t.name);
      })
    ).sort();
  } catch {
    return [];
  }
}

async function runFileCommand(page: Page, title: string): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill(title);
  await palette
    .locator('.item')
    .filter({ has: page.getByText(title, { exact: true }) })
    .first()
    .click();
}

test('a change made after the save is still reported unsaved after a reload', async ({ page }) => {
  await boot(page, 'kept');
  const first = await createTable(page, 'Saved', [{ field: 'name' }]);
  await waitForPanel(page, first);
  await firstSaveIntoAFolder(page, 'kept.edb');
  await settleClean(page);

  // A change the file has never seen.
  const second = await createTable(page, 'Later', [{ field: 'name' }]);
  await waitForPanel(page, second);
  await expect.poll(() => isDirty(page), { timeout: 15_000 }).toBe(true);

  await page.reload();
  await ready(page);
  await waitForPanel(page, second);

  // The whole bug in one line: this came back false, over a workspace holding a
  // table its file knows nothing about.
  await expect.poll(() => isDirty(page), { timeout: 20_000 }).toBe(true);
  expect(await tableNames(page)).toEqual(['Later', 'Saved']);
});

test('a workspace with no file at all stays unsaved across a reload', async ({ page }) => {
  // The rule in one case: the dot says "this is not in a file", and a refresh does
  // not put it in one. A first boot was already dirty — creating the workspace and
  // seeding the templates are writes — and every boot after it said "saved".
  await boot(page, 'nofile');
  const id = await createTable(page, 'Only', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await expect.poll(() => isDirty(page), { timeout: 15_000 }).toBe(true);

  await page.reload();
  await ready(page);
  await waitForPanel(page, id);

  await expect.poll(() => isDirty(page), { timeout: 20_000 }).toBe(true);
});

test('Open asks before it writes the file over unsaved work', async ({ page }) => {
  await boot(page, 'asked');
  const first = await createTable(page, 'Saved', [{ field: 'name' }]);
  await waitForPanel(page, first);
  await firstSaveIntoAFolder(page, 'asked.edb');

  const second = await createTable(page, 'Later', [{ field: 'name' }]);
  await waitForPanel(page, second);
  await expect.poll(() => isDirty(page), { timeout: 15_000 }).toBe(true);

  await runFileCommand(page, 'Open workspace file…');
  const dialog = page.locator('host-dialogs');
  await dialog.getByRole('button', { name: 'asked.edb', exact: true }).click();

  // Before this fix the next thing to happen was the import, and `Later` was gone.
  await expect(dialog.getByRole('button', { name: 'Use the browser copy', exact: true })).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Use the browser copy', exact: true }).click();

  await expect(dialog.getByText(/keeping the copy in this browser/)).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();

  await page.waitForURL(/space=asked/, { timeout: 20_000 });
  await ready(page);

  await expect.poll(() => tableNames(page), { timeout: 30_000 }).toEqual(['Later', 'Saved']);
  // Still unsaved: keeping the browser's copy wrote nothing.
  await expect.poll(() => isDirty(page), { timeout: 20_000 }).toBe(true);
});
