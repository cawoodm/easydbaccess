import { defineConfig } from 'vitest/config';

/**
 * One Vitest run for the whole repo. Every unit/integration suite lives under
 * `test/` (mirroring the package it covers: `test/renderer/…`, `test/electron/…`),
 * so there is a single config instead of one per workspace package.
 *
 * `test/e2e/` is Playwright's — its files are `.spec.ts`, which this `include`
 * deliberately does not match.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // SQLite's native bindings don't survive Vitest's default worker-thread
    // pool, and test/electron boots the real node:sqlite storage adapter.
    pool: 'forks',
  },
});
