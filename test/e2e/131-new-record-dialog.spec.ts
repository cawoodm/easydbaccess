import { test, expect, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The + button asks for the record instead of inserting a blank row.
 *
 * A blank row landed wherever the current sort put it — on a big table, somewhere
 * among 600,000 others — and had to be filled in cell by cell. The form asks for
 * the visible fields in one place, with the columns' own defaults already in the
 * boxes, and can reveal the hidden ones on request.
 *
 * Validation is shown, not enforced: the rules run as you type and Save still
 * writes the record. A record half-known is worth keeping.
 */

const footer = (page: Page, id: string) => page.locator(`#${panelDomId(id)} panel-footer`);
const form = (page: Page) => page.locator('new-record-dialog dialog');
const addButton = (page: Page, id: string) => footer(page, id).getByRole('button', { name: /Add row/ });

/** A field's input, found by the label the form shows. */
const boxFor = (page: Page, label: string) => form(page).locator('label.field', { hasText: label }).locator('input, textarea').first();

/** Every row in the table, straight from the store. */
const rowsOf = (page: Page, id: string) =>
  page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (t) => ((await (window as any).__easydb.store.rows(t).find()) as Array<{ data: Record<string, unknown> }>).map((r) => r.data),
    id,
  );

test.describe('the new-record form', () => {
  test('the + button opens a form instead of adding a blank row', async ({ page }) => {
    const id = await createTable(page, 'Parts', [{ field: 'sku' }, { field: 'qty', type: 'number' }]);
    await waitForPanel(page, id);

    await addButton(page, id).click();
    await expect(form(page)).toBeVisible();
    // Nothing is written until Save — the old behaviour inserted the row on click.
    expect(await rowsOf(page, id)).toEqual([]);
    await expect(footer(page, id)).toContainText('0 rows');

    await boxFor(page, 'sku').fill('A-1');
    await boxFor(page, 'qty').fill('4');
    await form(page).getByRole('button', { name: 'Save', exact: true }).click();

    await expect(form(page)).toBeHidden();
    expect(await rowsOf(page, id)).toEqual([{ sku: 'A-1', qty: 4 }]);
    await expect(footer(page, id)).toContainText('1 row');
  });

  test('shows the visible fields, and the rest only when asked', async ({ page }) => {
    const id = await createTable(page, 'Staff', [
      { field: 'name' },
      { field: 'internal', hidden: true },
      { field: 'total', script: 'function render(row) { return 1; }' },
      { field: 'joined', readonly: true },
    ]);
    await waitForPanel(page, id);
    await addButton(page, id).click();
    await expect(form(page)).toBeVisible();

    // `total` is scripted and IS asked for: a script may read its own column's
    // stored cell, so a new record has to be able to carry one. `joined` is
    // `readonly` — no write target at all — and never appears.
    const fields = form(page).locator('label.field');
    await expect(fields).toHaveCount(2);
    await expect(fields.first()).toContainText('name');

    await form(page).locator('label.toggle input').check();
    // The hidden column appears; the `readonly` one never does — it is derived,
    // so there is nowhere to put an answer.
    await expect(fields).toHaveCount(3);
    await expect(form(page)).toContainText('internal');
    await expect(form(page)).toContainText('total');
    await expect(form(page)).not.toContainText('joined');
  });

  test('a column default is already in the box, and is written for hidden fields too', async ({ page }) => {
    const id = await createTable(page, 'Orders', [
      { field: 'status', default: 'new' },
      { field: 'source', hidden: true, default: 'manual' },
    ]);
    await waitForPanel(page, id);
    await addButton(page, id).click();
    await expect(boxFor(page, 'status')).toHaveValue('new');

    await form(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form(page)).toBeHidden();
    // The hidden column was never on the form and still got its default: the row
    // has to have the same shape whichever way it was added.
    expect(await rowsOf(page, id)).toEqual([{ status: 'new', source: 'manual' }]);
  });

  test('a broken rule is shown as you type, and Save still writes the record', async ({ page }) => {
    const id = await createTable(page, 'People', [
      { field: 'name', notnull: true },
      { field: 'code', max: 3 },
    ]);
    await waitForPanel(page, id);
    await addButton(page, id).click();

    // `name` is required and starts empty, so the form says so before anything
    // is typed.
    await expect(form(page)).toContainText('name cannot be empty.');
    await boxFor(page, 'code').fill('abcd');
    await expect(form(page)).toContainText('code must be at most 3 characters (got 4).');
    await expect(form(page)).toContainText('2 fields do not meet their rules');

    // The first press only arms the button — "Save anyway" is something the user
    // reads before it happens, not after.
    await form(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form(page)).toBeVisible();
    const anyway = form(page).getByRole('button', { name: 'Save anyway', exact: true });
    await expect(anyway).toBeVisible();

    await anyway.click();
    await expect(form(page)).toBeHidden();
    // Kept exactly as typed, rules and all.
    expect(await rowsOf(page, id)).toEqual([{ name: '', code: 'abcd' }]);
    await expect(page.locator('toast-host')).toContainText(/unresolved problem/i);
  });

  test('fixing the fields turns Save back into a plain Save', async ({ page }) => {
    const id = await createTable(page, 'Guests', [{ field: 'name', notnull: true }]);
    await waitForPanel(page, id);
    await addButton(page, id).click();

    await expect(form(page)).toContainText('cannot be empty');
    await boxFor(page, 'name').fill('Ada');
    await expect(form(page)).not.toContainText('cannot be empty');
    await expect(form(page)).not.toContainText('do not meet their rules');

    await form(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form(page)).toBeHidden();
    expect(await rowsOf(page, id)).toEqual([{ name: 'Ada' }]);
  });

  test("a column's validate script decides too, and sees the whole record", async ({ page }) => {
    const id = await createTable(page, 'Ranges', [
      { field: 'low', type: 'number' },
      { field: 'high', type: 'number', validate: 'function validate(value, row) { if (value != null && row.low != null && value < row.low) throw new Error("high must not be below low"); }' },
    ]);
    await waitForPanel(page, id);
    await addButton(page, id).click();

    await boxFor(page, 'low').fill('10');
    await boxFor(page, 'high').fill('2');
    await expect(form(page)).toContainText('high must not be below low');

    // Raising `low`'s sibling clears it — the script reads the record as it would
    // be, not as stored, so editing either field re-judges the pair.
    await boxFor(page, 'high').fill('20');
    await expect(form(page)).not.toContainText('high must not be below low');
  });

  test('Cancel writes nothing', async ({ page }) => {
    const id = await createTable(page, 'Nothing', [{ field: 'a' }]);
    await waitForPanel(page, id);
    await addButton(page, id).click();
    await boxFor(page, 'a').fill('typed');
    await form(page).getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(form(page)).toBeHidden();
    expect(await rowsOf(page, id)).toEqual([]);
  });

  test('a table with no fields to fill in adds the row straight away', async ({ page }) => {
    // No columns means no form worth opening: a dialog with one sentence and a
    // Save button is a worse way to add an empty row than the button just pressed.
    const id = await createTable(page, 'Empty', []);
    await waitForPanel(page, id);
    await addButton(page, id).click();

    await expect(footer(page, id)).toContainText('1 row');
    await expect(form(page)).toHaveCount(0);
  });
});
