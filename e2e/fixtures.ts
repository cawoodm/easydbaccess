import { test as base, expect, type Page } from '@playwright/test';

/**
 * Shared fixtures for renderer e2e tests.
 *
 * `app` — boots the renderer at `?test=1&space=<unique>` and waits for the
 * test-ready event. Each test gets its own workspace id so RxDB stores
 * don't leak between tests. IndexedDB is wiped before each test too.
 */
export interface AppFixture {
  /** The Playwright page, after the app is booted and the test hook is live. */
  page: Page;
  /** Unique workspace id for this test. */
  workspaceId: string;
}

export const test = base.extend<AppFixture>({
  workspaceId: async ({}, use, testInfo) => {
    // Per-test-invocation random suffix so server-side state (the Hono
    // backend stores one blob per workspaceId at .playwright-storage/) is
    // always fresh — without it, a rerun would see the previous run's blob
    // and the "seeds via PUT when server is empty" assertion would fail.
    const nonce = Math.random().toString(36).slice(2, 8);
    await use(`e2e-${testInfo.testId}-${nonce}`.replace(/[^a-z0-9_-]/gi, '-'));
  },
  page: async ({ page, workspaceId }, use) => {
    // Wipe IndexedDB before each test so workspace lookups don't see stale data
    // from a previous run. This runs BEFORE any app code, via init script.
    await page.addInitScript(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__easydbResetIDB = async () => {
        const dbs = await indexedDB.databases?.();
        if (!dbs) return;
        await Promise.all(
          dbs.map(
            (d) =>
              new Promise<void>((resolve) => {
                if (!d.name) return resolve();
                const req = indexedDB.deleteDatabase(d.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              }),
          ),
        );
      };
    });

    await page.goto('/?test=0');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.evaluate(async () => (window as any).__easydbResetIDB?.());

    await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
      { timeout: 15_000 },
    );

    await use(page);
  },
});

export { expect };
