import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The samples dropdown is no longer only what the app ships: any script can be
 * saved to it. One list per kind, held in a workspace setting — so a sample
 * saved on a column is offered on a view token too, and the other way round,
 * because both are `render(row)`.
 */

const MY_SCRIPT = 'function render(row) { return String(row.a ?? "").toUpperCase(); }';

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

/** Saves the editor's current text as a sample called `name`. */
async function saveAsSample(page: import('@playwright/test').Page, name: string) {
  const editor = page.locator('script-editor-dialog dialog');
  await editor.getByRole('button', { name: 'Add to samples' }).click();
  const host = page.locator('host-dialogs');
  await host.locator('input').fill(name);
  await host.getByRole('button', { name: 'OK', exact: true }).click();
}

test('a script saved as a sample is offered again, and is stored on the workspace', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Shout', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);

  await dlg.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await editor.locator('textarea').fill(MY_SCRIPT);
  await saveAsSample(page, 'Shout it');

  // Offered right away, under its own group — no reopen needed.
  const samples = editor.locator('select#sample');
  await expect(samples.locator('optgroup[label="Your samples"] option')).toHaveText(['Shout it']);

  // One workspace setting holds the list, so a gist push or a dump carries it.
  const stored = await page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    const rows = await store.settings.find({ workspaceId: ws });
    return rows.find((s: { name: string }) => s.name === 'scripts:samples')?.value ?? null;
  }, workspaceId);
  expect(stored).toMatchObject([{ kind: 'render', label: 'Shout it', source: MY_SCRIPT }]);

  // And picking it puts the script back in the editor.
  await editor.locator('textarea').fill('');
  await samples.selectOption({ label: 'Shout it' });
  await expect(editor.locator('textarea')).toHaveValue(MY_SCRIPT);
});

test('a sample saved on a column is offered on a view token, and one saved there is offered on a column', async ({ page }) => {
  const id = await createTable(page, 'Posts', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ a: 'hi' }]);

  // Save one from the COLUMN editor.
  const cols = await openColumns(page, id);
  await cols.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await editor.locator('textarea').fill(MY_SCRIPT);
  await saveAsSample(page, 'From a column');
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await cols.getByRole('button', { name: 'Cancel' }).click();

  // A view token's editor offers it — the same `render(row)` shape, one list.
  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const views = page.locator('views-dialog dialog');
  await views.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
  await views.locator('.map-row', { hasText: '$TITLE' }).getByRole('button', { name: 'ƒ(x)' }).click();
  await expect(editor.locator('optgroup[label="Your samples"] option')).toHaveText(['From a column']);

  // Saving from HERE lands in the same list…
  await editor.locator('textarea').fill('function render(row) { return "from a view"; }');
  await saveAsSample(page, 'From a view');
  await expect(editor.locator('optgroup[label="Your samples"] option')).toHaveText(['From a column', 'From a view']);
  await editor.getByRole('button', { name: 'Cancel' }).click();
  await views.getByRole('button', { name: 'Back' }).click();
  await views.getByRole('button', { name: 'Close' }).click();

  // …so the column editor now offers both.
  const cols2 = await openColumns(page, id);
  await cols2.locator('button.script-btn').first().click();
  await expect(editor.locator('optgroup[label="Your samples"] option')).toHaveText(['From a column', 'From a view']);
});

test('a validation sample stays out of the render list', async ({ page }) => {
  const id = await createTable(page, 'Guarded', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);

  await dlg.locator('button.validate-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await editor.locator('textarea').fill('function validate(value, row) { if (!value) throw new Error("no"); }');
  await saveAsSample(page, 'Never empty');
  await expect(editor.locator('optgroup[label="Your samples"] option')).toHaveText(['Never empty']);
  await editor.getByRole('button', { name: 'Cancel' }).click();

  // The render pencil's dropdown has no user group at all — a validator is not
  // a renderer, and offering it there would only ever produce a broken script.
  await dlg.locator('button.script-btn').first().click();
  await expect(editor.locator('optgroup[label="Your samples"]')).toHaveCount(0);
});

test('the trash deletes the picked sample after a confirm, and declining keeps it', async ({ page }) => {
  const id = await createTable(page, 'Shout', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);

  await dlg.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await editor.locator('textarea').fill(MY_SCRIPT);
  await saveAsSample(page, 'Shout it');

  const trash = editor.locator('button.icon.danger');
  await expect(trash).toHaveAttribute('title', 'Delete the sample "Shout it"');
  const host = page.locator('host-dialogs');

  // Declining keeps it.
  await trash.click();
  await expect(host.getByText('Delete the sample "Shout it"?')).toBeVisible();
  await host.getByRole('button', { name: 'No', exact: true }).click();
  await expect(editor.locator('optgroup[label="Your samples"] option')).toHaveText(['Shout it']);

  // Accepting removes it from the dropdown and from the store, while the script
  // in the editor is left alone — deleting the sample is not undoing the work.
  await trash.click();
  await host.getByRole('button', { name: 'Yes', exact: true }).click();
  await expect(editor.locator('optgroup[label="Your samples"]')).toHaveCount(0);
  await expect(editor.locator('textarea')).toHaveValue(MY_SCRIPT);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const rows = await store.settings.find();
        return rows.find((s: { name: string }) => s.name === 'scripts:samples')?.value ?? null;
      }),
    )
    .toEqual([]);
});

test('a built-in sample cannot be deleted — the trash is disabled for it', async ({ page }) => {
  const id = await createTable(page, 'Shout', [{ field: 'a' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);

  await dlg.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  const trash = editor.locator('button.icon.danger');

  // Nothing picked yet.
  await expect(trash).toBeDisabled();

  // A built-in is code, not content — picking one leaves the trash disabled.
  await editor.locator('select#sample').selectOption({ label: 'Join two fields into one' });
  await expect(editor.locator('textarea')).toHaveValue(/filter\(Boolean\)/);
  await expect(trash).toBeDisabled();
});
