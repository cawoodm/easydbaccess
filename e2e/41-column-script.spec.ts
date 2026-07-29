import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A column script used to be tied to the `script` renderer, whose output is
 * injected as raw HTML. A script can now be set on ANY column: its
 * `render(row)` return value replaces the stored value on the way into the
 * column's renderer, so `link` can point at a computed URL, `boolean` can show a
 * derived flag, and a column with no renderer shows the computed text.
 *
 * A scripted cell is read-only — the value is derived from the row, so there is
 * nowhere to write an edit back to. The `script` renderer keeps its own pencil
 * (covered by 05-cell-editing) because there the stored value is still the
 * cell's own.
 */

function cellsOf(page: import('@playwright/test').Page, tableId: string) {
  return page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td');
}

test('a script with no renderer shows its computed value as text', async ({ page }) => {
  const id = await createTable(page, 'Computed', [
    { field: 'first' },
    { field: 'last' },
    {
      field: 'full',
      script: 'function render(row) { return row.first + " " + row.last; }',
    },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { first: 'Ada', last: 'Lovelace' });

  await expect(cellsOf(page, id).nth(2)).toHaveText('Ada Lovelace');

  // Derived, so nothing is stored for the column and there is no editor.
  await expect(cellsOf(page, id).nth(2).locator('input')).toHaveCount(0);
  expect((await readRows(page, id))[0]?.data.full).toBeUndefined();
});

test('the script output is what the link renderer receives', async ({ page }) => {
  const id = await createTable(page, 'Linked', [
    { field: 'repo' },
    {
      field: 'url',
      renderer: 'link',
      script: 'function render(row) { return "https://github.com/" + row.repo; }',
    },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { repo: 'cawoodm/easydbaccess' });

  // The link renderer turned the COMPUTED value into an anchor — the stored
  // `url` field is empty, so without the script there would be nothing to link.
  const link = cellsOf(page, id).nth(1).locator('a');
  await expect(link).toHaveAttribute('href', 'https://github.com/cawoodm/easydbaccess');
});

test('a non-string script value reaches a renderer that wants one', async ({ page }) => {
  // One row per table so the assertion does not depend on row order.
  async function stockBox(qty: number, label: string) {
    const id = await createTable(page, label, [
      { field: 'qty', type: 'number' },
      {
        field: 'inStock',
        type: 'boolean',
        renderer: 'boolean',
        script: 'function render(row) { return row.qty > 0; }',
      },
    ]);
    await waitForPanel(page, id);
    await addRow(page, id, { qty });
    return page
      .locator(`#${panelDomId(id)}`)
      .locator('data-table tbody td cell-boolean input[type="checkbox"]');
  }

  // The script returns a real boolean and the boolean renderer honours it.
  const inStock = await stockBox(5, 'HasStock');
  await expect(inStock).toBeChecked();
  // A scripted cell is read-only — the value is derived, so it cannot be toggled.
  await expect(inStock).toBeDisabled();

  const outOfStock = await stockBox(0, 'NoStock');
  await expect(outOfStock).not.toBeChecked();
});

test('a script that throws shows an inline chip and leaves the row readable', async ({ page }) => {
  const id = await createTable(page, 'Broken', [
    { field: 'name' },
    { field: 'oops', script: 'function render(row) { return row.missing.deep; }' },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'still here' });

  const err = cellsOf(page, id).nth(1).locator('.script-err');
  await expect(err).toHaveText(/runtime error/);
  // The rest of the row is unaffected — one broken script is not fatal. An
  // un-scripted column with no renderer is still an editable input.
  await expect(cellsOf(page, id).nth(0).locator('input')).toHaveValue('still here');
});

test('a script that does not compile says so', async ({ page }) => {
  const id = await createTable(page, 'Unparsed', [
    { field: 'name' },
    { field: 'oops', script: 'function render(row) { return' },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'x' });

  await expect(cellsOf(page, id).nth(1).locator('.script-err')).toHaveText(/compile error/);
});

test('the column editor offers the script button on every column, not just script-rendered ones', async ({
  page,
}) => {
  const id = await createTable(page, 'Editable', [
    { field: 'plain' },
    { field: 'linked', renderer: 'link' },
  ]);
  await waitForPanel(page, id);

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();

  // One script button per column row, whatever the renderer.
  const scriptBtns = dlg.locator('button.icon-btn[title*="script"]');
  await expect(scriptBtns).toHaveCount(2);

  // Opening one shows the editor pre-filled with the render(row) boilerplate.
  await scriptBtns.first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await expect(editor).toBeVisible();
  await expect(editor.locator('textarea')).toHaveValue(/function render\(row\)/);
});

test('the renderer dropdown no longer offers a dedicated "script" renderer', async ({ page }) => {
  // The old `script` cell renderer duplicated this generic path (it ran the
  // same column.script and injected the result as raw HTML). Removing it means
  // the dropdown — populated live from `registries.cellRenderers` — should
  // simply no longer list it, with no special-casing required.
  const id = await createTable(page, 'Renderers', [{ field: 'plain' }]);
  await waitForPanel(page, id);

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();

  const rendererSelect = dlg.locator('.col-row select[title^="Renderer"]');
  await expect(rendererSelect.locator('option[value="script"]')).toHaveCount(0);
  // Still-supported renderers remain listed.
  await expect(rendererSelect.locator('option[value="link"]')).toHaveCount(1);
});
