import { defineConfig } from '@playwright/test';

/**
 * E2E tests for the DESKTOP app — its own config, not a project inside
 * `playwright.config.ts`.
 *
 * That config starts two web servers (Vite on the branch's port, and the backing
 * Hono server) and hands every test a `baseURL`. The desktop suite needs none of
 * it: Electron loads the built renderer over `file://` and stores its data in a
 * SQLite file. As a second project it would still pay for both servers on every
 * run.
 *
 * The specs live under `test/e2e/desktop/`, inside the browser suite's tree, so
 * that the repo's existing decisions about Playwright specs keep covering them —
 * `test/e2e/**` is what `eslint.config.mjs` ignores and `test/tsconfig.json`
 * excludes, and `test/e2e/helpers.ts` is what drives a table through the real
 * HostApi. `playwright.config.ts` ignores `desktop/**` so the browser project
 * does not try to run them.
 *
 * Run it with `npm run test:e2e:desktop`.
 */
export default defineConfig({
  testDir: './test/e2e/desktop',
  // One app at a time. Each test launches a real Electron process with its own
  // temp `userData`, so they cannot corrupt each other's data — but several
  // desktop apps competing for the machine makes the timeout below meaningless.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // An app launch plus a workspace boot is slower than a page load, and some of
  // these launch twice to model a restart. The default 30s leaves nothing for the
  // test once a cold start has eaten it.
  timeout: 90_000,
  // Builds the renderer bundle and the main process before anything runs, so a
  // stale `dist/` cannot produce a pass that says nothing about the current code.
  globalSetup: './test/e2e/desktop/build-setup.ts',
  use: {
    trace: 'on-first-retry',
  },
});
