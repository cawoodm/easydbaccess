import { test, expect } from '@playwright/test';

/**
 * Multi-tab schema-upgrade safety.
 *
 * When the app ships a Dexie schema bump (new object stores), the upgrade can
 * only run in an IndexedDB `versionchange` transaction — which is BLOCKED while
 * another tab still holds the database open at the OLD version. Before the fix,
 * the newer tab's `open()` hung forever on a blank screen ("v0.0.47 completely
 * broken"). Now the blocked tab surfaces an actionable overlay, and once the
 * old connection yields the app boots normally.
 *
 * The test simulates the "old tab" with a raw IndexedDB connection opened at
 * version 1 and held open, then boots the real app (which wants version ≥2) in
 * a second same-origin tab.
 */

// v1 schema, mirroring dexie-db.ts `raw.version(1).stores(...)`, created via raw
// IndexedDB so the holder tab never runs app code (i.e. never upgrades itself).
const SEED_AND_HOLD_V1 = `(async () => {
  await new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase('easydb');
    del.onsuccess = del.onerror = del.onblocked = () => resolve();
  });
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('easydb', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('workspaces', { keyPath: 'id' });
      const tables = db.createObjectStore('tables', { keyPath: 'id' });
      tables.createIndex('workspaceId', 'workspaceId');
      tables.createIndex('updatedAt', 'updatedAt');
      const rows = db.createObjectStore('rows', { keyPath: 'id' });
      rows.createIndex('tableId', 'tableId');
      rows.createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('plugins', { keyPath: 'url' });
    };
    req.onsuccess = () => {
      // Hold the connection open at v1 with NO versionchange handler, exactly
      // like an old tab running pre-fix code — this is what blocks the upgrade.
      window.__heldDb = req.result;
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
})()`;

test('a blocked schema upgrade shows an actionable overlay, then boots once the old tab yields', async ({
  browser,
}) => {
  const context = await browser.newContext();
  try {
    // Holder tab: a blank same-origin page that keeps an old v1 DB open.
    const holder = await context.newPage();
    await holder.route('**/*', (route) => {
      if (route.request().resourceType() === 'document') {
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>db-holder</title>',
        });
      } else {
        route.abort();
      }
    });
    await holder.goto('http://localhost:5190/db-upgrade-holder');
    await holder.evaluate(SEED_AND_HOLD_V1);

    // App tab: the real renderer wants version ≥2 → its open() is blocked.
    const app = await context.newPage();
    await app.goto('http://localhost:5190/?test=1&space=upgrade-block');
    const overlay = app.locator('#easydb-upgrade-blocked');
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(overlay).toContainText(/another tab/i);

    // The old tab yields (its owner closed it / navigated away).
    await holder.evaluate(() => {
      (window as unknown as { __heldDb?: IDBDatabase }).__heldDb?.close();
    });
    await holder.close();

    // Reloading the blocked tab now boots cleanly against the upgraded schema.
    await app.locator('#easydb-upgrade-reload').click();
    await app.waitForFunction(
      () => Boolean((window as unknown as { __easydb?: unknown }).__easydb),
      { timeout: 15_000 },
    );
    await expect(app.locator('#easydb-upgrade-blocked')).toHaveCount(0);
  } finally {
    await context.close();
  }
});
