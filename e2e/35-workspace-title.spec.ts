import { test, expect } from './fixtures.js';

/**
 * TODO § General
 * - Workspace title: editable in Settings → General, shown in the header
 *   instead of "easyDBAccess"; persists across reload; blank reverts to the
 *   default. It also prefixes the BROWSER TAB title, so several open
 *   workspaces are tellable apart from the tab strip alone.
 * - The app ships an SVG favicon.
 */

test.describe('workspace title', () => {
  test('editing the title in Settings updates the header and persists', async ({ page }) => {
    const header = page.locator('app-shell header');
    await expect(header.locator('strong')).toContainText('easyDBAccess');

    await header.getByTitle('Workspace and plugin settings').click();
    const dialog = page.locator('settings-dialog');
    await expect(dialog.locator('dialog')).toBeVisible();

    const titleInput = dialog.getByPlaceholder('easyDBAccess');
    await titleInput.fill('Acme Inventory');
    await titleInput.blur();

    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(header.locator('strong')).toContainText('Acme Inventory');
    await expect(header.locator('strong')).not.toContainText('easyDBAccess');

    await page.reload();
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb));
    await expect(page.locator('app-shell header strong')).toContainText('Acme Inventory');
  });

  test('clearing the title reverts the header to the default', async ({ page }) => {
    const header = page.locator('app-shell header');
    await header.getByTitle('Workspace and plugin settings').click();
    const dialog = page.locator('settings-dialog');
    const titleInput = dialog.getByPlaceholder('easyDBAccess');

    await titleInput.fill('Temporary Title');
    await titleInput.blur();
    await expect(header.locator('strong')).toContainText('Temporary Title');

    await titleInput.fill('');
    await titleInput.blur();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(header.locator('strong')).toContainText('easyDBAccess');
  });
});

test('the workspace title prefixes the browser tab title', async ({ page }) => {
  // The static <title> from index.html is the base, and keeps the version.
  const base = await page.title();
  expect(base).toMatch(/^easyDBAccess v\d+\.\d+\.\d+$/);

  const header = page.locator('app-shell header');
  await header.getByTitle('Workspace and plugin settings').click();
  const dialog = page.locator('settings-dialog');
  const titleInput = dialog.getByPlaceholder('easyDBAccess');

  // Live — no reload, and the app name/version stay as the suffix.
  await titleInput.fill('Newsroom Q3');
  await titleInput.blur();
  await expect.poll(() => page.title()).toBe(`Newsroom Q3 — ${base}`);

  // Clearing it falls back to the base title rather than leaving a stray dash.
  await titleInput.fill('');
  await titleInput.blur();
  await expect.poll(() => page.title()).toBe(base);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
});

test('an SVG favicon is linked and served', async ({ page }) => {
  const href = await page.locator('link[rel="icon"]').getAttribute('href');
  // index.html writes it relative (so a deploy subpath resolves); the dev server
  // normalizes that to "/favicon.svg" against its own base. Either form is fine
  // — what matters is which file it points at.
  expect(href).toMatch(/(^|\/)favicon\.svg$/);

  // And it must actually be there, not just referenced.
  const url = new URL(href!, page.url()).toString();
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/svg+xml');
  expect(await res.text()).toContain('<svg');
});
