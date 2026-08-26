import { test, expect, type Page } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A column's two scripts can be PARKED — kept on the column, but not run.
 *
 * Before this, the only way to stop a script was to delete its body, which threw
 * the work away; the common case is a rule you are debugging, or one that has to
 * be off for an afternoon while data is loaded. So each script now carries a
 * switch, and the column editor's button paints all three states:
 *
 *   gray  — no script            (`is-none`)
 *   blue  — a script that runs   (`is-on`)
 *   red   — a script, parked     (`is-off`)
 *
 * The two buttons also stopped being the same pencil: the validation one is the
 * `rule` glyph, so the colour is free to mean state and nothing else.
 */

const COMPUTE = `function render(row) {
  return 'computed:' + row.code;
}`;

const REJECT_SHORT = `function validate(value, row) {
  if (String(value).length < 3) throw new Error('Needs at least 3 characters.');
}`;

async function openColumns(page: Page, id: string) {
  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: /Columns/ })
    .click();
  const dlg = page.locator('new-table-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
}

/** Open one of the two script editors and set its switch, then Save. */
async function setSwitch(page: Page, dlg: ReturnType<Page['locator']>, which: 'script-btn' | 'validate-btn', on: boolean) {
  await dlg.locator(`button.${which}`).first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await expect(editor).toBeVisible();
  const box = editor.locator('input[data-testid="script-active"]');
  await expect(box).toBeVisible();
  await box.setChecked(on);
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();
}

test('the two buttons are different glyphs, so the colours can mean state', async ({ page }) => {
  const id = await createTable(page, 'Glyphs', [{ field: 'code', renderer: 'link' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);

  // The whole point of the icon change: two identical pencils side by side read
  // as one wide control, and no colour scheme fixes that.
  await expect(dlg.locator('button.script-btn .mi').first()).toHaveText('edit');
  await expect(dlg.locator('button.validate-btn .mi').first()).toHaveText('rule');
});

test('a column with no script starts gray', async ({ page }) => {
  const id = await createTable(page, 'Bare', [{ field: 'code', renderer: 'link' }]);
  await waitForPanel(page, id);
  const dlg = await openColumns(page, id);

  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-none/);
  await expect(dlg.locator('button.validate-btn').first()).toHaveClass(/is-none/);
});

test('parking a render script turns its button red and stops the grid computing', async ({ page }) => {
  // No renderer on purpose: a scripted column with none shows the computed value
  // as plain text in the cell, which is the one place the switch's effect can be
  // read directly rather than through a renderer's own shadow root.
  const id = await createTable(page, 'Parked', [{ field: 'code', script: COMPUTE }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'abc' });

  const cell = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td')
    .first();
  await expect(cell).toContainText('computed:abc');

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-on/);
  await setSwitch(page, dlg, 'script-btn', false);
  // Red before anything is saved — the editor's own state, like the other flags.
  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-off/);
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  // The stored value is what shows now, in an ordinary editable input: a scripted
  // cell is read-only (there is nowhere to write a derived value back to), so the
  // input appearing is itself proof the script is no longer in the way.
  await expect(cell).not.toContainText('computed:');
  await expect(cell.locator('input')).toHaveValue('abc');

  // And the body is still there: parked, not deleted.
  const kept = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = (await ctx.store.tables.find()).find((x: { id: string }) => x.id === tableId);
    return { script: t.columns[0].script as string | undefined, active: t.columns[0].scriptActive as boolean | undefined };
  }, id);
  expect(kept.script).toContain('computed:');
  expect(kept.active).toBe(false);
});

test('switching it back on computes again', async ({ page }) => {
  const id = await createTable(page, 'Revived', [{ field: 'code', script: COMPUTE }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'abc' });

  let dlg = await openColumns(page, id);
  await setSwitch(page, dlg, 'script-btn', false);
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  dlg = await openColumns(page, id);
  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-off/);
  await setSwitch(page, dlg, 'script-btn', true);
  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-on/);
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  const cell = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td')
    .first();
  await expect(cell).toContainText('computed:abc');
});

test('a parked validation rule lets the edit through', async ({ page }) => {
  const id = await createTable(page, 'Unenforced', [{ field: 'code', renderer: 'link', validate: REJECT_SHORT }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'abcd' });

  const dlg = await openColumns(page, id);
  await expect(dlg.locator('button.validate-btn').first()).toHaveClass(/is-on/);
  await setSwitch(page, dlg, 'validate-btn', false);
  await expect(dlg.locator('button.validate-btn').first()).toHaveClass(/is-off/);
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  const input = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td input')
    .first();
  await input.fill('ab');
  await input.dispatchEvent('change');

  // No "Cannot save" dialog, and the two-character value is stored — the rule is
  // on the column and doing nothing, which is exactly what "parked" means.
  await expect(page.locator('host-dialogs')).not.toContainText('Needs at least 3 characters.');
  await expect.poll(async () => (await readRows(page, id))[0]?.data.code).toBe('ab');
});

test('the two switches are independent', async ({ page }) => {
  // Parking a column's display script must not quietly stop its edits being
  // checked — they are two rules about two different things.
  const id = await createTable(page, 'Both', [{ field: 'code', script: COMPUTE, validate: REJECT_SHORT }]);
  await waitForPanel(page, id);

  const dlg = await openColumns(page, id);
  await setSwitch(page, dlg, 'script-btn', false);
  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-off/);
  await expect(dlg.locator('button.validate-btn').first()).toHaveClass(/is-on/);
});

test('clearing the body clears the switch with it', async ({ page }) => {
  // Otherwise a column that gets a NEW script later would inherit "off" from one
  // deleted months earlier, and the author would think the new script is broken.
  const id = await createTable(page, 'Cleared', [{ field: 'code', script: COMPUTE }]);
  await waitForPanel(page, id);

  let dlg = await openColumns(page, id);
  await setSwitch(page, dlg, 'script-btn', false);
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  dlg = await openColumns(page, id);
  await dlg.locator('button.script-btn').first().click();
  const editor = page.locator('script-editor-dialog dialog');
  await editor.locator('textarea').fill('');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(dlg.locator('button.script-btn').first()).toHaveClass(/is-none/);
  await dlg.getByRole('button', { name: /Save|Create/ }).click();
  await expect(dlg).toBeHidden();

  const stored = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const t = (await ctx.store.tables.find()).find((x: { id: string }) => x.id === tableId);
    return { script: t.columns[0].script as string | undefined, active: t.columns[0].scriptActive as boolean | undefined };
  }, id);
  expect(stored.script).toBeUndefined();
  expect(stored.active).toBeUndefined();
});
