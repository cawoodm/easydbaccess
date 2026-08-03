import { defineConfig } from 'vitest/config';

/**
 * One Vitest run for the whole repo. Every unit/integration suite lives under
 * `test/` (mirroring the package it covers: `test/renderer/…`, `test/server/…`),
 * so there is a single config instead of one per workspace package.
 *
 * `test/e2e/` is Playwright's — its files are `.spec.ts`, which this `include`
 * deliberately does not match.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // SQLite's native bindings don't survive Vitest's default worker-thread
    // pool, and test/server boots the real sqlite storage adapter.
    pool: 'forks',
    // Keeps the server's request logger out of the test output.
    env: {
      EASYDB_LOG: 'quiet',
    },
  },
});
