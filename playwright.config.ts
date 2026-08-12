import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { resolveDevPort, resolveServerPort } from './scripts/dev-port.mjs';

/**
 * E2E tests for the renderer. Playwright launches Vite, waits for the dev
 * server, then runs Chromium tests against it. Tests use a `?test=1` query
 * param so the renderer exposes a window-level handle for direct invocation
 * of host APIs — see packages/renderer/src/main.ts.
 *
 * Per-test isolation: each test opens its own `?space=` workspace so the
 * RxDB/IndexedDB store from one test doesn't pollute another. The page
 * also wipes IndexedDB in `beforeEach` for belt-and-braces.
 *
 * Both ports — the renderer's and the backing server's — are resolved from
 * the current branch (see scripts/dev-port.mjs), so e2e always targets
 * whichever ports THIS checkout actually runs on, never a hardcoded pair that
 * might belong to a different worktree. Specs read the server URL from
 * `test/e2e/server-url.ts`, which calls the same resolver.
 */
const rendererPort = resolveDevPort();
const baseURL = `http://localhost:${rendererPort}`;
const serverPort = resolveServerPort();

export default defineConfig({
  testDir: './test/e2e',
  // The desktop suite lives in here too, but it launches Electron instead of
  // using a page — it has its own config (`playwright.electron.config.ts`) and
  // must not be run by this one. It sits under test/e2e/ so that the lint and
  // typecheck exclusions for Playwright specs, and `helpers.ts`, cover it.
  testIgnore: ['desktop/**'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'npm run dev:renderer',
      url: baseURL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // Backing server for auto-sync e2e. Node 22+ — sqlite-store is OK.
      // PORT/STORAGE_* env pre-empts packages/server/.env (process.loadEnvFile
      // documents that it doesn't overwrite existing process.env entries).
      // The port is per-branch (renderer port + 1000) so parallel worktrees
      // each get their own server instead of the first one to start locking
      // the others out via CORS.
      command: 'npm run dev:server',
      url: `http://localhost:${serverPort}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        PORT: String(serverPort),
        STORAGE_KIND: 'fs',
        STORAGE_PATH: '.playwright-storage',
        CORS_ORIGINS: baseURL,
        // Curated registry served at /plugins/registry — exercised by
        // test/e2e/13-plugins-registry.spec.ts. Resolve to absolute because
        // `npm run dev:server` changes cwd to packages/server/ where a
        // bare relative path would miss.
        PLUGINS_REGISTRY_PATH: resolve('test/e2e/fixtures/plugins-registry.json'),
      },
    },
  ],
});
