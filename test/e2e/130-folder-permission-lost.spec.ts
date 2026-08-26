import { expect, test, type Page } from '@playwright/test';
import { createTable } from './helpers.js';

/**
 * A folder grant does not always survive a restart: Chrome drops it unless the
 * user chose "Allow on every visit", and clearing site data drops it always.
 *
 * The tab then boots on whatever the pool holds — for a workspace whose data
 * lives in a file, that is nothing — and every permission check at boot read the
 * answer and threw it away. So the app came up empty and silent, and the file was
 * still sitting there, unreadable and unmentioned.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `126-one-workspace-per-file.spec.ts`. `queryPermission` is stubbed separately,
 * because that is the half a restart changes.
 */

const FOLDER = 'perm-lost';

/**
 * Boot with the folder picker stubbed. `denied` makes every permission query
 * answer "prompt" — what a browser reports for a grant it has forgotten.
 */
async function boot(page: Page, workspaceId: string, opts: { denied?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ folder, denied }) => {
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      (window as unknown as Record<string, unknown>)['showDirectoryPicker'] = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(folder, { create: true });
      };
      if (!denied) return;
      // A handle whose permission has lapsed: `queryPermission` says 'prompt',
      // and `requestPermission` is what a click would have to call.
      const proto = (globalThis as unknown as { FileSystemHandle?: { prototype: Record<string, unknown> } }).FileSystemHandle?.prototype;
      if (proto) {
        proto['queryPermission'] = async () => 'prompt';
        proto['requestPermission'] = async () => 'prompt';
      }
    },
    { folder: FOLDER, denied: opts.denied === true },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

async function connectFolder(page: Page): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('workspace folder');
  await palette
    .locator('.item', { hasText: /Connect workspace folder/ })
    .first()
    .click();
}

test('a lapsed folder permission is reported, not swallowed', async ({ page }) => {
  await boot(page, 'kanban');
  await createTable(page, 'tasks', [{ field: 'name' }]);

  // Save adopts the file it writes, so this tab is FILE-BACKED from here on —
  // the state the report is about. The dialog's own button is the gesture the
  // folder picker needs.
  await page.locator('app-shell').getByRole('button', { name: /Save/ }).click();
  const first = page.locator('host-dialogs');
  await expect(first.getByText(/stored in this browser/)).toBeVisible();
  await first.getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(page.locator('toast-host')).toContainText('kanban.edb', { timeout: 30_000 });

  // The restart: same origin, same stored handles, no permission.
  await boot(page, 'kanban', { denied: true });

  const dialog = page.locator('host-dialogs');
  await expect(dialog).toContainText('may no longer open', { timeout: 20_000 });
  await expect(dialog).toContainText('still in the file');
});

test('a workspace with data of its own is not nagged about the folder', async ({ page }) => {
  // Losing the grant matters least when there is something on screen: Save says
  // so when it is next pressed, and a dialog on every boot would be noise.
  await boot(page, 'kanban');
  await createTable(page, 'tasks', [{ field: 'name' }]);
  await connectFolder(page);
  await expect(page.locator('toast-host')).toContainText('workspace(s)', { timeout: 30_000 });

  await boot(page, 'kanban', { denied: true });
  await expect(page.locator('host-dialogs')).not.toContainText('may no longer open');
});

test('a workspace that never had a folder is asked nothing', async ({ page }) => {
  // The prompt must not greet a browser-only workspace, which has no file and is
  // missing nothing.
  await boot(page, 'plain', { denied: true });
  await createTable(page, 'notes', [{ field: 'x' }]);

  await expect(page.locator('host-dialogs')).not.toContainText('may no longer open');
});
