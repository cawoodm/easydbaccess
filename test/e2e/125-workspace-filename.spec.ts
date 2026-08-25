import { expect, test, type Page } from '@playwright/test';
import { createTable, waitForPanel } from './helpers.js';

/**
 * Where a workspace lives, said in the two places the question comes up.
 *
 * The workspace list keeps the file OUT of the text — a list of
 * "workspace ┈ workspace.edb" reads every name twice — so hovering is the answer,
 * and it used to answer nothing at all for the workspace you were in: only the
 * entries from OTHER files carried a tooltip. The Save toast had the same gap: it
 * said "Workspace saved" and left "where?" to be guessed.
 */

const FOLDER = 'filename-target';

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
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/** The tooltip on the selected workspace's own entry in the list. */
function selectedTooltip(page: Page) {
  return page.locator('app-shell footer workspace-selector select option[selected]').first();
}

test('the list says which file the open workspace is in, and Save names it', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const ws = `where-${testInfo.testId}`.toLowerCase();
  const file = `${ws}.edb`;
  await boot(page, ws);

  const id = await createTable(page, 'parts', [{ field: 'part', type: 'string' }]);
  await waitForPanel(page, id);

  // Nothing adopted yet, so the honest answer is the browser — NOT `index.edp`,
  // which would send the user looking for a file they never chose.
  await expect(selectedTooltip(page)).toHaveAttribute('title', 'Stored in this browser');

  // First Save asks where the workspace should live; the folder's button is the
  // gesture the picker needs.
  await page.locator('app-shell').getByRole('button', { name: /Save/ }).click();
  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/stored in this browser/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect a folder…', exact: true }).click();

  // The toast names the file it wrote.
  await expect(page.locator('toast-host')).toContainText(`Workspace saved to ${file}`, { timeout: 30_000 });

  // And from here on the list says the same thing on hover.
  await expect.poll(() => selectedTooltip(page).getAttribute('title'), { timeout: 30_000 }).toBe(file);
});
