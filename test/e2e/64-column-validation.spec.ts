import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A column's SECOND script: `validate(value, row)`, run when someone edits a
 * cell by hand. It rejects by throwing, and the thrown message is what the
 * "Cannot save" dialog shows.
 *
 * Its pencil sits to the right of the Max input in the column editor — next to
 * the other constraints (Max / Unique / Not null) rather than next to the
 * render-script pencil, because that is what it is: one more rule about what a
 * cell may hold.
 */

const REJECT_SHORT = `function validate(value, row) {
  if (String(value).length < 3) throw new Error('Needs at least 3 characters.');
}`;

test('a throwing validator rejects the edit and shows its message', async ({ page }) => {
  const id = await createTable(page, 'Guarded', [{ field: 'code', renderer: 'link', validate: REJECT_SHORT }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'abcd' });

  const input = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td input')
    .first();
  await input.fill('ab');
  await input.dispatchEvent('change');

  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText('Needs at least 3 characters.')).toBeVisible();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();

  // Nothing was written. (The input keeps showing the rejected text until the
  // next render — the same as for a Max or Unique rejection, which this path
  // shares; see the note in commitCell.)
  expect((await readRows(page, id))[0]?.data.code).toBe('abcd');
});

test('a validator that does not throw lets the edit through', async ({ page }) => {
  const id = await createTable(page, 'Permissive', [{ field: 'code', renderer: 'link', validate: REJECT_SHORT }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'abcd' });

  const input = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td input')
    .first();
  await input.fill('wxyz');
  await input.dispatchEvent('change');

  await expect.poll(async () => (await readRows(page, id))[0]?.data.code).toBe('wxyz');
  await expect(page.locator('host-dialogs dialog')).toBeHidden();
});

test('the validator sees the pending edit, so a cross-field rule reads the new value', async ({ page }) => {
  const id = await createTable(page, 'Range', [
    { field: 'start', renderer: 'link' },
    {
      field: 'end',
      renderer: 'link',
      validate: 'function validate(value, row) { if (value < row.start) throw new Error("End is before start."); }',
    },
  ]);
  await waitForPanel(page, id);
  await addRow(page, id, { start: '2026-03-01', end: '2026-04-01' });

  const endInput = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td input')
    .nth(1);
  await endInput.fill('2026-02-01');
  await endInput.dispatchEvent('change');

  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText('End is before start.')).toBeVisible();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  expect((await readRows(page, id))[0]?.data.end).toBe('2026-04-01');
});

test('a broken validator says so instead of silently allowing the edit', async ({ page }) => {
  const id = await createTable(page, 'Broken', [{ field: 'code', renderer: 'link', validate: 'function validate(value) { if (' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'ok' });

  const input = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td input')
    .first();
  await input.fill('changed');
  await input.dispatchEvent('change');

  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/compile error/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'OK', exact: true }).click();
  expect((await readRows(page, id))[0]?.data.code).toBe('ok');
});

test('the built-in constraints still get the first word', async ({ page }) => {
  // Max is checked before the script, so an overlong value reports the length
  // limit — the script author never has to re-implement it.
  const id = await createTable(page, 'Both', [{ field: 'code', renderer: 'link', validate: REJECT_SHORT }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ tableId }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const t = await ctx.store.tables.findOne(tableId);
      const cols = t.columns.map((c: { field: string }) => (c.field === 'code' ? { ...c, max: 5 } : c));
      await ctx.store.tables.patch(tableId, { columns: cols, updatedAt: Date.now() });
    },
    { tableId: id },
  );
  await addRow(page, id, { code: 'abcd' });

  const input = page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr td input')
    .first();
  await input.fill('abcdefgh');
  await input.dispatchEvent('change');

  const dialog = page.locator('host-dialogs');
  await expect(dialog.getByText(/at most 5 characters/i)).toBeVisible();
});

test('bulk writes are not edits — an import is never blocked by a validator', async ({ page }) => {
  const id = await createTable(page, 'Imported', [{ field: 'code', renderer: 'link', validate: 'function validate() { throw new Error("always rejects"); }' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { code: 'x' }); // written through the store, not the grid

  expect((await readRows(page, id))[0]?.data.code).toBe('x');
  await expect(page.locator('host-dialogs dialog')).toBeHidden();
});

test.describe('the column editor', () => {
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

  test('puts the validation pencil right of the Max input, one per column', async ({ page }) => {
    const id = await createTable(page, 'Layout', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    const dlg = await openColumns(page, id);

    await expect(dlg.locator('button.validate-btn')).toHaveCount(2);

    // Order within the row: the Max number input, then the validation pencil.
    const firstRow = dlg.locator('.col-row').first();
    const order = await firstRow.evaluate((row) =>
      Array.from(row.children).map((el) => (el.tagName === 'INPUT' ? `input:${(el as HTMLInputElement).type}` : el.className || el.tagName.toLowerCase())),
    );
    const maxIdx = order.indexOf('input:number');
    expect(maxIdx).toBeGreaterThan(-1);
    expect(order[maxIdx + 1]).toContain('validate-btn');
  });

  test('opens the validation editor with its own boilerplate and the samples dropdown', async ({ page }) => {
    const id = await createTable(page, 'Samples', [{ field: 'a' }]);
    await waitForPanel(page, id);
    const dlg = await openColumns(page, id);

    await dlg.locator('button.validate-btn').first().click();
    const editor = page.locator('script-editor-dialog dialog');
    await expect(editor).toBeVisible();
    await expect(editor.locator('h2')).toContainText('Edit validation');
    await expect(editor.locator('textarea')).toHaveValue(/function validate\(value, row\)/);

    // Ten ready-made rules, plus the "— choose —" placeholder.
    const samples = editor.locator('select#sample');
    await expect(samples.locator('option')).toHaveCount(11);

    // Picking one replaces the editor contents…
    await samples.selectOption({ label: 'Email address' });
    await expect(editor.locator('textarea')).toHaveValue(/valid email address/);
    // …and can be undone, because a stray pick shouldn't eat a written rule.
    await editor.getByRole('button', { name: 'Undo' }).click();
    await expect(editor.locator('textarea')).toHaveValue(/function validate\(value, row\)/);
    await expect(editor.locator('textarea')).not.toHaveValue(/valid email address/);
  });

  test('saves a sample onto the column, which then enforces it', async ({ page }) => {
    const id = await createTable(page, 'Enforced', [{ field: 'code', renderer: 'link' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { code: 'draft' });
    const dlg = await openColumns(page, id);

    await dlg.locator('button.validate-btn').first().click();
    const editor = page.locator('script-editor-dialog dialog');
    await editor.locator('select#sample').selectOption({ label: 'One of a fixed list of values' });
    await editor.getByRole('button', { name: 'Save' }).click();

    // The pencil now shows the column carries a rule, before anything is saved.
    await expect(dlg.locator('button.validate-btn').first()).toHaveClass(/has-validate/);
    await dlg.getByRole('button', { name: /Save|Create/ }).click();
    await expect(dlg).toBeHidden();

    const input = page
      .locator(`#${panelDomId(id)}`)
      .locator('data-table tbody tr td input')
      .first();
    await input.fill('archived');
    await input.dispatchEvent('change');

    const alert = page.locator('host-dialogs');
    await expect(alert.getByText(/is not allowed. Pick one of: draft, review, published/)).toBeVisible();
    await alert.getByRole('button', { name: 'OK', exact: true }).click();
    expect((await readRows(page, id))[0]?.data.code).toBe('draft');
  });

  test('clearing the editor removes the rule from the column', async ({ page }) => {
    const id = await createTable(page, 'Cleared', [{ field: 'code', renderer: 'link', validate: REJECT_SHORT }]);
    await waitForPanel(page, id);
    const dlg = await openColumns(page, id);

    const pencil = dlg.locator('button.validate-btn').first();
    await expect(pencil).toHaveClass(/has-validate/);
    await pencil.click();
    const editor = page.locator('script-editor-dialog dialog');
    await editor.locator('textarea').fill('');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(pencil).not.toHaveClass(/has-validate/);

    await dlg.getByRole('button', { name: /Save|Create/ }).click();
    await expect(dlg).toBeHidden();

    const stored = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tid) => (window as any).__easydb.store.tables.findOne(tid),
      id,
    );
    expect(stored?.columns[0]?.validate).toBeUndefined();
  });
});
