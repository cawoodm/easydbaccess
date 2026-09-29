import { expect, test, type Page } from '@playwright/test';

/**
 * The settings that are not about one workspace live in the FOLDER.
 *
 * Everything device-local used to be `localStorage`, which is per ORIGIN. Open
 * the same folder in another browser, on another machine or in a private window
 * and every preference, token and machine URL was gone — even though the data
 * itself came across in the `.edb` files. Moving the folder to a new disk did
 * the same, because nothing in the folder said what the setup was.
 *
 * `_easydb.edp`, beside the workspace files, carries it. `.edp` and not `.edb`
 * on purpose: the extension already means "not one workspace", so every place
 * that enumerates the folder for workspaces skips it with no exclusion list to
 * keep correct — which is what the last test here holds down.
 *
 * `showDirectoryPicker` is stubbed with an OPFS directory handle, as in
 * `127-folder-sync-writes-out.spec.ts`.
 */

const FOLDER = 'device-state';

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

/** Run the palette command that connects a folder — the picker is stubbed. */
async function connectFolder(page: Page): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill('workspace folder');
  // "Connect…" the first time, "Change…" once one is connected — one command,
  // two titles (see `folderCommand.title` in `edb-file.ts`).
  await palette
    .locator('.item', { hasText: /workspace folder/i })
    .first()
    .click();
}

/**
 * What a different browser looks like: the device layer gone, but the folder
 * still granted. Reloading is the honest half — the mirror this tab holds in
 * memory would otherwise answer every read and the test would pass without the
 * file being involved at all.
 */
async function asAFreshBrowser(page: Page, workspaceId: string): Promise<void> {
  await page.evaluate(() => {
    localStorage.removeItem('/easydbaccess/settings.json');
    localStorage.removeItem('/easydbaccess/secrets.txt');
  });
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

const setSetting = (page: Page, key: string, value: string) =>
  page.evaluate(
    ({ k, v }) => {
      const all = JSON.parse(localStorage.getItem('/easydbaccess/settings.json') ?? '{}') as Record<string, unknown>;
      all[k] = v;
      // Through the app, so it goes down the same path a Settings write does.
      return (window as unknown as { __easydb: { api: { settings: { set(p: string, key: string, val: unknown, scope: string): Promise<void> } } } }).__easydb.api.settings.set(
        k.split(':')[0] ?? 'grid',
        k.split(':')[1] ?? 'x',
        v,
        'user',
      );
    },
    { k: key, v: value },
  );

const readSetting = (page: Page, pluginId: string, key: string) =>
  page.evaluate(({ p, k }) => (window as unknown as { __easydb: { api: { settings: { get(p: string, k: string): Promise<unknown> } } } }).__easydb.api.settings.get(p, k), { p: pluginId, k: key });

const folderHas = (page: Page, file: string) =>
  page.evaluate(
    async ({ folder, name }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle(folder);
        return (await (await dir.getFileHandle(name)).getFile()).size > 0;
      } catch {
        return false;
      }
    },
    { folder: FOLDER, name: file },
  );

test('connecting a folder writes the device settings into it', async ({ page }) => {
  await boot(page, 'alpha');
  await setSetting(page, 'grid:defaultSubstring', 'no');
  await connectFolder(page);

  await expect.poll(() => folderHas(page, '_easydb.edp'), { timeout: 30_000 }).toBe(true);
});

test('a browser that knows nothing gets its settings back from the folder', async ({ page }) => {
  // The whole feature, end to end: set something, connect, wipe the browser,
  // reconnect, and the setting is there without it ever having been typed again.
  await boot(page, 'alpha');
  await setSetting(page, 'grid:defaultSubstring', 'no');
  await connectFolder(page);
  await expect.poll(() => folderHas(page, '_easydb.edp'), { timeout: 30_000 }).toBe(true);

  await asAFreshBrowser(page, 'alpha');

  // Nothing was typed again: boot found the folder it is still allowed to read
  // and took the setting out of it.
  await expect.poll(() => readSetting(page, 'grid', 'defaultSubstring'), { timeout: 30_000 }).toBe('no');
});

test('secrets travel with the folder too', async ({ page }) => {
  // An explicit decision, not a side effect — without it "connect the folder and
  // it works" is false, because every connector still needs re-authenticating.
  await boot(page, 'alpha');
  await page.evaluate(() => localStorage.setItem('/easydbaccess/secrets.txt', 'token: s3cr3t'));
  await connectFolder(page);
  await expect.poll(() => folderHas(page, '_easydb.edp'), { timeout: 30_000 }).toBe(true);

  await asAFreshBrowser(page, 'alpha');

  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('/easydbaccess/secrets.txt')), { timeout: 30_000 })
    .toBe('token: s3cr3t');
});

test('the device file is not offered as a workspace', async ({ page }) => {
  // `.edp` is what buys this: `listWorkspaceFiles` matches `.edb`, so nothing
  // downstream ever sees the device file. Naming it `_easydb.edb` would have put
  // an exclusion rule in every enumerator, and one missed spot offers the user
  // their own settings file to open as a workspace.
  await boot(page, 'alpha');
  await setSetting(page, 'grid:defaultSubstring', 'no');
  await connectFolder(page);
  await expect.poll(() => folderHas(page, '_easydb.edp'), { timeout: 30_000 }).toBe(true);

  const names = await page.evaluate(() => {
    const raw = localStorage.getItem('/easydbaccess/folder-index.json') ?? '{}';
    const idx = JSON.parse(raw) as { files?: string[]; workspaces?: { file: string }[] };
    return [...(idx.files ?? []), ...(idx.workspaces ?? []).map((w) => w.file)];
  });
  expect(names.some((n) => n.includes('_easydb'))).toBe(false);
});
