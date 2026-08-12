import { test, expect } from '@playwright/test';
import { closeDesktop, desktopDir, launchDesktop, type Desktop } from './desktop.js';

/**
 * The desktop app starts, and starts on the RIGHT store.
 *
 * The last assertion is the one worth having: in the browser the same renderer
 * would have booted on Dexie/IndexedDB, and every storage claim the desktop makes
 * rests on it having picked the IPC bridge to the main-process SQLite file
 * instead. `app-context.ts` decides that from `window.easydb.store` alone, so a
 * preload that failed to load would silently give a working app backed by the
 * wrong thing.
 */
test.describe('desktop boot', () => {
  let desktop: Desktop | null = null;

  test.afterEach(async () => {
    await closeDesktop(desktop);
    desktop = null;
  });

  test('opens a window on the workspace file named on the command line', async () => {
    desktop = await launchDesktop(desktopDir());

    await expect(desktop.page.locator('app-shell')).toBeVisible();

    const platform = await desktop.page.evaluate(() => window.easydb?.platform);
    expect(platform).toBe('electron');

    // `db:path` is the store's own view of which file it opened. It must be the
    // one passed on the command line, not the default in `userData`.
    const openedPath = await desktop.page.evaluate(() => window.easydb!.store.dbPath());
    expect(openedPath).toBe(desktop.dbPath);
  });

  test('the renderer is backed by the SQLite store, not Dexie', async () => {
    desktop = await launchDesktop(desktopDir());

    const backing = await desktop.page.evaluate(async () => ({
      hasBridge: Boolean(window.easydb?.store),
      canListIdb: typeof indexedDB.databases === 'function',
      // On the IPC path `getDb()` is never called, so Dexie never opens its
      // database — there is no IndexedDB database at all, not merely an empty one.
      idb: (await indexedDB.databases?.())?.map((d) => d.name) ?? [],
    }));

    // Guards the assertion below from passing for the wrong reason: an absent
    // `databases()` would report "no Dexie" on a Dexie-backed app too.
    expect(backing.canListIdb).toBe(true);
    expect(backing.hasBridge).toBe(true);
    expect(backing.idb).toEqual([]);
  });
});
