import { defineConfig, devices } from '@playwright/test';

/**
 * E2E tests for the renderer. Playwright launches Vite, waits for the dev
 * server, then runs Chromium tests against it. Tests use a `?test=1` query
 * param so the renderer exposes a window-level handle for direct invocation
 * of host APIs — see packages/renderer/src/main.ts.
 *
 * Per-test isolation: each test opens its own `?space=` workspace so the
 * RxDB/IndexedDB store from one test doesn't pollute another. The page
 * also wipes IndexedDB in `beforeEach` for belt-and-braces.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:5190',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev:renderer',
    url: 'http://localhost:5190',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
