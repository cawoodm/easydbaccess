import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A column script's output is preferred, and `null` hands the cell back to its
 * STORED value.
 *
 * That one rule is what makes a scripted column editable. A scripted cell used to
 * be read-only everywhere, on the reasoning that a derived value has nowhere to
 * write back to — true of the value, but not of the cell underneath it, which the
 * script itself usually reads. So a script that decorates only the rows it
 * recognises now leaves the rest as ordinary cells you can type into, and reads
 * what you typed on the next render.
 *
 * `return ''` is deliberately NOT a decline: that is a script saying "show
 * nothing here", which is an answer.
 */

/** Decorates a row that has a value, and declines for one that does not. */
const DECORATE = `function render(row) {
  if (!row.code) return null;
  return 'ref:' + row.code;
}`;

const COLUMNS = [
  { field: 'name', renderer: 'link' },
  { field: 'code', script: DECORATE },
];

async function seed(page: Page, rows: Array<Record<string, unknown>>, columns = COLUMNS) {
  const id = await createTable(page, 'refs', columns);
  await bulkAddRows(page, id, rows);
  await waitForPanel(page, id);
  return id;
}

/** The cell at `col` of the first row. */
const cell = (page: Page, id: string, col: number) =>
  page
    .locator(`#${panelDomId(id)}`)
    .locator('data-table tbody tr')
    .first()
    .locator('td')
    .nth(col);

test('a script that answers wins, and its cell stays read-only', async ({ page }) => {
  const id = await seed(page, [{ name: 'first', code: 'A1' }]);

  await expect(cell(page, id, 1)).toContainText('ref:A1');
  // Computed: there is nothing to write the displayed value back to.
  await expect(cell(page, id, 1).locator('input')).toHaveCount(0);
});

test('a script that returns null shows the stored value in an editable cell', async ({ page }) => {
  const id = await seed(page, [{ name: 'blank', code: '' }]);

  // The script declined, so the column falls back to being an ordinary one — the
  // whole point, since the stored cell is what the script reads.
  const input = cell(page, id, 1).locator('input');
  await expect(input).toHaveCount(1);
  await expect(input).toHaveValue('');
});

test('typing into a declined cell writes the stored value, and the script picks it up', async ({ page }) => {
  const id = await seed(page, [{ name: 'blank', code: '' }]);

  const input = cell(page, id, 1).locator('input');
  await input.fill('B2');
  await input.dispatchEvent('change');

  // Stored as typed...
  await expect.poll(async () => (await readRows(page, id))[0]?.data.code).toBe('B2');
  // ...and the script now has something to say about the row, so the cell goes
  // back to being computed. This round trip is what "the script may refer to its
  // own raw content" means in practice.
  await expect(cell(page, id, 1)).toContainText('ref:B2');
  await expect(cell(page, id, 1).locator('input')).toHaveCount(0);
});

test('rows decline independently — one cell computed, its neighbour editable', async ({ page }) => {
  const id = await seed(page, [
    { name: 'has', code: 'A1' },
    { name: 'has not', code: '' },
  ]);

  const rows = page.locator(`#${panelDomId(id)}`).locator('data-table tbody tr');
  await expect(rows.nth(0).locator('td').nth(1)).toContainText('ref:A1');
  await expect(rows.nth(0).locator('td').nth(1).locator('input')).toHaveCount(0);
  await expect(rows.nth(1).locator('td').nth(1).locator('input')).toHaveCount(1);
});

test('an empty string is an answer, not a decline', async ({ page }) => {
  // `return ''` means "show nothing here". Reading it as a decline would show the
  // stored value instead — the opposite of what the script asked for.
  const id = await seed(page, [{ name: 'x', code: 'A1' }], [
    { field: 'name', renderer: 'link' },
    { field: 'code', script: 'function render(row) {\n  return "";\n}' },
  ]);

  await expect(cell(page, id, 1)).toHaveText('');
  await expect(cell(page, id, 1).locator('input')).toHaveCount(0);
});

test('a script that returns nothing at all declines', async ({ page }) => {
  // Falling off the end returns undefined, which means the same as null — a
  // half-written script leaves the data reachable rather than hiding it.
  const id = await seed(page, [{ name: 'x', code: 'A1' }], [
    { field: 'name', renderer: 'link' },
    { field: 'code', script: 'function render(row) {\n  // nothing yet\n}' },
  ]);

  await expect(cell(page, id, 1).locator('input')).toHaveValue('A1');
});

test('a broken script still shows its error, not the stored value', async ({ page }) => {
  // A throw is not a decline. Silently showing the raw value would hide the fault
  // and leave the author wondering why the script does nothing.
  const id = await seed(page, [{ name: 'x', code: 'A1' }], [
    { field: 'name', renderer: 'link' },
    { field: 'code', script: 'function render(row) {\n  throw new Error("nope");\n}' },
  ]);

  await expect(cell(page, id, 1)).toContainText('runtime error');
});

test('the new-record form asks for a scripted column', async ({ page }) => {
  // It used to skip them as "derived". A new record has to be able to carry the
  // value the script reads, or the script has nothing to work from.
  const id = await seed(page, [{ name: 'x', code: 'A1' }]);

  await page
    .locator(`#${panelDomId(id)}`)
    .locator('panel-footer')
    .getByRole('button', { name: '+', exact: true })
    .click();

  const dialog = page.locator('new-record-dialog dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-field="code"]')).toHaveCount(1);
});
