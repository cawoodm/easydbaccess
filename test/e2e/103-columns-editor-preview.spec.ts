import { test, expect } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The columns editor's live preview showed nothing on a big table.
 *
 * It was awaited BEFORE the dialog was shown, over a read of the whole table —
 * so the editor arrived late, and when that read failed it arrived saying "No
 * rows to preview", which reads as "this table is empty". The read now asks for
 * a hundred rows, happens after the dialog is on screen, and says which of the
 * three things it means: reading, nothing there, or could not be read.
 */

async function openColumns(page: import('@playwright/test').Page, id: string) {
  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
}

test('the preview reads a hundred rows, whatever the table holds', async ({ page }) => {
  const id = await createTable(page, 'Many', [{ field: 'n' }]);
  await waitForPanel(page, id);
  await bulkAddRows(
    page,
    id,
    Array.from({ length: 250 }, (_, i) => ({ n: `row${i}` })),
  );

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('.preview h3')).toContainText('first 100 rows');
  await expect(dlg.locator('.preview tbody tr')).toHaveCount(100);
});

test('an empty table says so', async ({ page }) => {
  const id = await createTable(page, 'Empty', [{ field: 'n' }]);
  await waitForPanel(page, id);

  const dlg = await openColumns(page, id);
  await expect(dlg.getByTestId('preview-empty')).toHaveText('No rows to preview.');
});

test('cells are DRAWN by their renderer, not printed as text', async ({ page }) => {
  // The renderer picker is one row above the preview. Showing every value as
  // plain text made it the one setting in the dialog whose effect the preview
  // could not show.
  const id = await createTable(page, 'Rendered', [{ field: 'site', renderer: 'link' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { site: 'https://example.com' });

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('.preview tbody a')).toHaveAttribute('href', 'https://example.com');
});

test('a scripted column previews what the script computes, not the empty cell behind it', async ({ page }) => {
  const id = await createTable(page, 'Computed', [{ field: 'n', type: 'number' }, { field: 'double', type: 'number', script: 'function render(row) { return row.n * 2; }' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { n: 21 });

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('.preview tbody tr').first()).toContainText('42');
});

test('a script that throws says so in the cell, and only in that cell', async ({ page }) => {
  const id = await createTable(page, 'Broken', [
    { field: 'n', type: 'number' },
    { field: 'd', script: 'function render(row) { if (row.n > 5) throw new Error("n too big"); return row.n; }' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ n: 1 }, { n: 9 }]);

  const dlg = await openColumns(page, id);
  const rows = dlg.locator('.preview tbody tr');
  await expect(rows.nth(0)).not.toContainText('n too big');
  await expect(rows.nth(1)).toContainText('n too big');
});

test('the validate script runs, and the cell says which rule rejected it', async ({ page }) => {
  const id = await createTable(page, 'Checked', [{ field: 'n', type: 'number', validate: 'function validate(value) { if (value > 5) throw new Error("must be 5 or less"); }' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ n: 3 }, { n: 9 }]);

  const dlg = await openColumns(page, id);
  const bad = dlg.locator('.preview tbody td.violation');
  await expect(bad).toHaveCount(1);
  await expect(bad).toHaveAttribute('title', 'n must be 5 or less');
});

test('the preview is inert: a renderer that offers an editor cannot be typed into', async ({ page }) => {
  // Renderers are plugins and may ignore `readonly` — `cell-link` puts its pencil
  // up regardless. With no change handler wired, an edit made here would be
  // silently discarded, so nothing in the preview takes a click at all.
  const id = await createTable(page, 'Inert', [{ field: 'site', renderer: 'link' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { site: 'https://example.com' });

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('.preview table')).toHaveAttribute('inert', '');
});

test('the grip resizes the preview, and the size is remembered', async ({ page }) => {
  const id = await createTable(page, 'Tall', [{ field: 'n' }]);
  await waitForPanel(page, id);
  await bulkAddRows(
    page,
    id,
    Array.from({ length: 60 }, (_, i) => ({ n: `row${i}` })),
  );

  const dlg = await openColumns(page, id);
  const preview = dlg.locator('.preview');
  const before = (await preview.boundingBox())?.height ?? 0;

  const grip = dlg.locator('.grip');
  const box = await grip.boundingBox();
  if (!box) throw new Error('no grip');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Up is bigger: the grip is the pane's top edge, so it follows the pointer.
  await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => (await preview.boundingBox())?.height ?? 0).toBeGreaterThan(before + 60);

  // Remembered on the device, so the size does not have to be re-dragged on
  // every open. It is presentation on THIS screen, so it is not in the workspace.
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  const reopened = await openColumns(page, id);
  await expect.poll(async () => (await reopened.locator('.preview').boundingBox())?.height ?? 0).toBeGreaterThan(before + 60);
});

test('a read that fails says so instead of claiming there are no rows', async ({ page }) => {
  const id = await createTable(page, 'Unreadable', [{ field: 'n' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { n: 'one' });

  // Break the row read. BOTH ways in: `readRows` prefers `query` where the store
  // has one, and Dexie has had one since 0.0.348 — breaking only `find` left the
  // preview working and this test asserting nothing. The grid subscribed with the
  // real collection when it mounted, so this reaches only the editor's own read.
  await page.evaluate((tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const real = ctx.store.rows.bind(ctx.store) as (t: string) => any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.store.rows = (tableId: string): any =>
      tableId === tid
        ? {
            ...real(tableId),
            find: () => Promise.reject(new Error('no')),
            query: () => Promise.reject(new Error('no')),
          }
        : real(tableId);
  }, id);

  const dlg = await openColumns(page, id);
  // With the REASON, not just the fact: "could not be read" on its own leaves
  // the user nothing to act on.
  await expect(dlg.getByTestId('preview-empty')).toContainText('could not be read');
  await expect(dlg.getByTestId('preview-empty')).toContainText('no');
  // The editor still works — the failure costs the preview, not the settings.
  await expect(dlg.getByRole('button', { name: /Save|Create/ })).toBeEnabled();
});
