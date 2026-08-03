import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `preview` windows open at a fixed 520x400, which is wider than a
 * phone — so on mobile they used to open partly off-screen and had to be
 * panned to be read. On a narrow viewport they now open MAXIMIZED, filling the
 * canvas. Desktop is untouched.
 *
 * The maximized panel is counter-transformed to fill the VISIBLE canvas through
 * pan/zoom (see panel-shell's applyMaxFill), so the check is on the rendered
 * bounding box, not the CSS width — that is what the user actually sees.
 */

const PHONE = { width: 390, height: 780 };
const DESKTOP = { width: 1280, height: 900 };

async function openPreview(page: import('@playwright/test').Page, name: string) {
  const tableId = await createTable(page, name, [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: '<p>Hello <b>World</b></p>' });
  const cell = page
    .locator(`#${panelDomId(tableId)}`)
    .locator('data-table tbody td preview-cell');
  await cell.locator('button').click();
  return page.locator('[id^="easydb-preview-popup-"]').last();
}

async function openEditor(page: import('@playwright/test').Page, name: string) {
  const tableId = await createTable(page, name, [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { note: '<p>Hello</p>' });
  // The truncated text (not its wrapper span) is what opens the source editor.
  await page
    .locator(`#${panelDomId(tableId)}`)
    .locator('data-table tbody td preview-cell [title="Click to edit"]')
    .click();
  return page.locator('[id^="easydb-html-edit-"]').last();
}

test('on a phone the HTML preview window opens maximized', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const popup = await openPreview(page, 'htmlmobile');

  await expect(popup).toHaveAttribute('data-status', 'maximized');
  // It really fills the canvas, rather than merely claiming the status.
  const box = await popup.boundingBox();
  const canvas = await page.locator('#easydb-panels').boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(canvas!.width - 2);
  // …and nothing hangs off the right edge, which was the actual complaint.
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width + 2);
});

test('on a desktop it still opens as a normal 520-wide floating window', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const popup = await openPreview(page, 'htmldesktop');

  await expect(popup).toHaveAttribute('data-status', 'normalized');
  const box = await popup.boundingBox();
  expect(box!.width).toBeLessThan(DESKTOP.width / 2);
});

test('Restore returns the maximized mobile popup to its normal size', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const popup = await openPreview(page, 'htmlrestore');
  await expect(popup).toHaveAttribute('data-status', 'maximized');

  // Booting maximized must not cost the window its normal rect — Restore is
  // the escape hatch, so it has to lead somewhere.
  await popup.locator('button[title="Restore"]').click();
  await expect(popup).toHaveAttribute('data-status', 'normalized');
  const box = await popup.boundingBox();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.width).toBeLessThan(popup.page().viewportSize()!.width * 2);
});

test('the HTML editor window opens maximized on a phone too', async ({ page }) => {
  await page.setViewportSize(PHONE);
  const editor = await openEditor(page, 'htmleditmobile');

  await expect(editor).toHaveAttribute('data-status', 'maximized');
  // Save/Cancel live at the content's bottom-right — the corner a too-wide
  // panel pushed off-screen first.
  await expect(editor.getByRole('button', { name: 'Save' })).toBeInViewport();
});

test('the HTML editor still floats on a desktop', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const editor = await openEditor(page, 'htmleditdesktop');
  await expect(editor).toHaveAttribute('data-status', 'normalized');
});
