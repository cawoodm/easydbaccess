import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Which protocols may be links is a setting (Settings → Links). A plain list is
 * the whole allow-list; the same list behind `!` says what to refuse and allows
 * everything else. The default is `!javascript,vbscript,data` — the three that run
 * code rather than going somewhere.
 *
 * And a `file:///` link, which is the reason the setting exists, is not blocked by
 * this app at all: the BROWSER refuses to navigate there from an http page, and
 * with `target="_blank"` it answers by opening a tab on `about:blank#blocked` and
 * saying nothing. So the click is caught and the path copied instead.
 */

const FILE_URL = 'file:///C:/projects/file.html';

async function linkTable(page: import('@playwright/test').Page, name: string, value = FILE_URL) {
  const id = await createTable(page, name, [{ field: 'doc', renderer: 'link' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { doc: value });
  return id;
}

const cellOf = (page: import('@playwright/test').Page, id: string) => page.locator(`#${panelDomId(id)}`).locator('data-table tbody td cell-link');

const openLinksTab = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Links' }).click();
  return dlg;
};

const protocolsField = (dlg: import('@playwright/test').Locator) => dlg.locator('.field', { hasText: 'Protocols that may be links' }).locator('input[type="text"]');

test('the default allows file:, and a click explains itself instead of opening a blank tab', async ({ page, context }) => {
  const id = await linkTable(page, 'protodefault');
  const link = cellOf(page, id).locator('a');
  await expect(link).toHaveAttribute('href', FILE_URL);

  await link.click();

  // The whole point: no second tab, and a message rather than silence.
  await expect(page.locator('toast-host')).toContainText('cannot open a local file');
  expect(context.pages()).toHaveLength(1);
  // …and this page did not go anywhere either.
  expect(page.url()).not.toContain('about:blank');
});

test('an allow-list turns a protocol it does not name back into plain text', async ({ page }) => {
  const id = await linkTable(page, 'protoallow');
  await expect(cellOf(page, id).locator('a')).toHaveCount(1);

  const dlg = await openLinksTab(page);
  const field = protocolsField(dlg);
  await expect(field).toHaveValue('!javascript,vbscript,data');
  await field.fill('http,https');
  await field.dispatchEvent('change');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();

  // The rule is read while painting, so the cell answers differently as soon as
  // it repaints — which a reload guarantees. The value is untouched.
  await page.reload();
  await waitForPanel(page, id);
  const cell = cellOf(page, id);
  await expect(cell.locator('a')).toHaveCount(0);
  await expect(cell.locator('input')).toHaveValue(FILE_URL);
});

test('a http link still works under that allow-list, and the setting survives a reload', async ({ page }) => {
  const id = await linkTable(page, 'protohttp', 'https://example.dev/doc');

  const dlg = await openLinksTab(page);
  const field = protocolsField(dlg);
  await field.fill('http,https');
  await field.dispatchEvent('change');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();

  await page.reload();
  await waitForPanel(page, id);
  await expect(cellOf(page, id).locator('a')).toHaveAttribute('href', 'https://example.dev/doc');

  // Stored on this device, so the field shows it again.
  await expect(protocolsField(await openLinksTab(page))).toHaveValue('http,https');
});

test('javascript: is refused whatever else changes', async ({ page }) => {
  const id = await linkTable(page, 'protojs', 'javascript:alert(1)');
  // Never a link — and the cell falls back to the editable input.
  await expect(cellOf(page, id).locator('a')).toHaveCount(0);

  const dlg = await openLinksTab(page);
  const field = protocolsField(dlg);
  // An allow-list that does not name it cannot resurrect it either.
  await field.fill('http,https,file');
  await field.dispatchEvent('change');
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await waitForPanel(page, id);
  await expect(cellOf(page, id).locator('a')).toHaveCount(0);
});
