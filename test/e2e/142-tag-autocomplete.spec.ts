import { test, expect, type Page } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Editing an `array` cell suggests the values the column already holds.
 *
 * Without it a tag vocabulary drifts by typing: `Bug`, `bug`, `bugs` and `bgu`
 * all become separate values, and nothing in the app ever tells you. The list is
 * the column's own members, so it is the vocabulary being reused rather than a
 * dictionary somebody has to maintain.
 *
 * The word being completed is the one at the CARET, not the whole cell — a cell
 * holds a list, so a native `<datalist>` could never have done this.
 */

const rows = [
  { name: 'a', tags: 'red, blue' },
  { name: 'b', tags: 'green' },
  { name: 'c', tags: 'evergreen, red' },
];

async function tagsTable(page: Page, name: string, seed = rows) {
  const id = await createTable(page, name, [{ field: 'name' }, { field: 'tags', type: 'array', renderer: 'tags' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, seed);
  return id;
}

const cell = (page: Page, id: string, row = 0) =>
  page
    .locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`)
    .nth(row)
    .locator('cell-tags');

const list = (page: Page) => page.locator('.tag-suggest');
const items = (page: Page) => page.locator('.tag-suggest .tag-suggest-item');

/** Open the raw-list editor the way a user does: the pencil in the cell. */
async function edit(page: Page, id: string, row = 0) {
  await cell(page, id, row).locator('button[title="Edit the list"]').click();
  const input = cell(page, id, row).locator('input');
  await expect(input).toBeFocused();
  return input;
}

test('opening the editor offers the whole vocabulary, minus what the cell has', async ({ page }) => {
  const id = await tagsTable(page, 'Vocab');
  await edit(page, id, 1); // row b: holds `green`

  await expect(list(page)).toBeVisible();
  // Sorted, and `green` is left out because this cell already carries it.
  await expect(items(page)).toHaveText(['blue', 'evergreen', 'red']);
});

test('typing narrows it, starts-with first', async ({ page }) => {
  const id = await tagsTable(page, 'Narrow');
  const input = await edit(page, id, 1);

  await input.fill('');
  await input.pressSequentially('gre');
  // Starts-with first, then contains. The cell's text is now just `gre`, so
  // `green` is no longer "already carried" — what the cell HOLDS is what its
  // text says, and the text is being rewritten.
  await expect(items(page)).toHaveText(['green', 'evergreen']);
});

test('a click on a suggestion inserts it and offers the next tag', async ({ page }) => {
  const id = await tagsTable(page, 'Click');
  const input = await edit(page, id, 1);

  await items(page).filter({ hasText: 'blue' }).click();
  // Inserted with a separator, so the next tag can be typed straight away…
  await expect(input).toHaveValue('green, blue, ');
  // …and the list is already offering what is left.
  await expect(items(page)).toHaveText(['evergreen', 'red']);
});

test('the keyboard drives it: arrow, Enter, then Enter again to save', async ({ page }) => {
  const id = await tagsTable(page, 'Keys');
  const input = await edit(page, id, 1);

  await input.press('ArrowDown'); // highlights `blue`
  await expect(items(page).first()).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter'); // takes it, rather than saving the cell
  await expect(input).toHaveValue('green, blue, ');

  // With nothing highlighted, Enter saves — a tag typed by hand needs no mouse.
  await input.press('Escape'); // close the list only
  await expect(list(page)).toHaveCount(0);
  await input.press('Enter');
  // Saved without the trailing separator the suggestion left behind.
  await expect.poll(async () => (await readRows(page, id)).find((r) => r.data.name === 'b')?.data.tags).toBe('green, blue');
});

test('Escape closes the list first and cancels the edit second', async ({ page }) => {
  const id = await tagsTable(page, 'Escape');
  const input = await edit(page, id, 1);
  await input.fill('green, nonsense');

  // The list is open (nothing matches "nonsense"? then reopen it deliberately).
  await input.fill('green, ');
  await expect(list(page)).toBeVisible();

  await input.press('Escape');
  await expect(list(page)).toHaveCount(0);
  // The editor is still open with what was typed — the first Escape must not
  // throw the edit away.
  await expect(cell(page, id, 1).locator('input')).toHaveValue('green, ');

  await cell(page, id, 1).locator('input').press('Escape');
  await expect(cell(page, id, 1).locator('input')).toHaveCount(0);
  // Cancelled: the stored value is untouched.
  expect((await readRows(page, id)).find((r) => r.data.name === 'b')?.data.tags).toBe('green');
});

test('the list survives the cell being narrow — it is a popover, not a child', async ({ page }) => {
  const id = await tagsTable(page, 'Clip');
  await edit(page, id, 1);

  // The cell clips its own content (`overflow:hidden`), so a list inside it would
  // be invisible. In the top layer it is not, and it sits below the input.
  const [cellBox, listBox] = await Promise.all([cell(page, id, 1).boundingBox(), list(page).boundingBox()]);
  expect(cellBox).not.toBeNull();
  expect(listBox).not.toBeNull();
  expect(listBox!.y).toBeGreaterThan(cellBox!.y);
  expect(listBox!.height).toBeGreaterThan(0);
});

test('a column with nothing in it yet suggests nothing', async ({ page }) => {
  const id = await createTable(page, 'Empty', [{ field: 'name' }, { field: 'tags', type: 'array', renderer: 'tags' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { name: 'a', tags: '' });

  await cell(page, id).locator('button[title="Edit the list"]').click();
  await expect(cell(page, id).locator('input')).toBeFocused();
  await expect(list(page)).toHaveCount(0);
});
