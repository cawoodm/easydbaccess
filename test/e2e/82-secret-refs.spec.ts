import { test, expect } from './fixtures.js';

/**
 * A setting may hold a `${secret:name}` reference; the secret behind it stays in
 * device-local storage and only the reference syncs.
 *
 * `settings.get` RESOLVES a reference, so any plugin that reads a setting, changes
 * something else and writes it back handed the SECRET to `settings.set` — which
 * replaced the reference with the value, and the value then synced. gist-sync did
 * exactly that when it saved the id of a newly created gist.
 *
 * These run through the real HostApi in the page, because the whole point is what
 * the store ends up holding.
 */

/** Put a secret in the device-local store, before anything reads it. */
async function seedSecret(page: import('@playwright/test').Page, line: string) {
  await page.evaluate((text) => {
    localStorage.setItem('/easydbaccess/secrets.txt', text);
  }, line);
}

/** The RAW stored value of a workspace setting — no interpolation. */
function rawWorkspace(page: import('@playwright/test').Page, key: string) {
  return page.evaluate(async (k) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return (await ctx.store.settings.findOne(k))?.value;
  }, key);
}

test('writing back a resolved secret leaves the reference in place', async ({ page }) => {
  await seedSecret(page, 'tok: ghp_realsecret');

  const out = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.api.settings.set('gist-sync', 'gist_token', '${secret:tok}', 'workspace');
    // What a plugin sees…
    const seen = await ctx.api.settings.get('gist-sync', 'gist_token');
    // …and what it used to write back, unknowingly.
    await ctx.api.settings.set('gist-sync', 'gist_token', seen, 'workspace');
    return { seen };
  });

  expect(out.seen).toBe('ghp_realsecret');
  expect(await rawWorkspace(page, 'gist-sync:gist_token')).toBe('${secret:tok}');
});

test('a real edit still goes through', async ({ page }) => {
  await seedSecret(page, 'tok: ghp_realsecret\nother: ghp_second');

  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.api.settings.set('gist-sync', 'gist_token', '${secret:tok}', 'workspace');
    // Pointing the field at another secret is an edit, not an overwrite.
    await ctx.api.settings.set('gist-sync', 'gist_token', '${secret:other}', 'workspace');
  });
  expect(await rawWorkspace(page, 'gist-sync:gist_token')).toBe('${secret:other}');

  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    // So is clearing it.
    await ctx.api.settings.set('gist-sync', 'gist_token', '', 'workspace');
  });
  expect(await rawWorkspace(page, 'gist-sync:gist_token')).toBe('');
});

test('a value embedded in text is protected the same way', async ({ page }) => {
  await seedSecret(page, 'tok: ghp_realsecret');

  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.api.settings.set('server-sync', 'url', 'https://s.dev/?k=${secret:tok}', 'workspace');
    const seen = await ctx.api.settings.get('server-sync', 'url');
    await ctx.api.settings.set('server-sync', 'url', seen, 'workspace');
  });

  expect(await rawWorkspace(page, 'server-sync:url')).toBe('https://s.dev/?k=${secret:tok}');
});

test('an ordinary setting is untouched by the rule', async ({ page }) => {
  await seedSecret(page, 'tok: ghp_realsecret');

  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.api.settings.set('server-sync', 'url', 'https://one.dev', 'workspace');
    await ctx.api.settings.set('server-sync', 'url', 'https://two.dev', 'workspace');
  });

  expect(await rawWorkspace(page, 'server-sync:url')).toBe('https://two.dev');
});
