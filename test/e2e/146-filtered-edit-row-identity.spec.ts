import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Editing a row OUT of the filter must not leave the row below it wearing the
 * edit.
 *
 * The grid drew its rows with a plain `map`, so Lit reused the DOM parts BY
 * POSITION. A cell is an `<input>` whose `.value` binding is dirty-checked
 * against the last value BOUND, not against what is in the box — so when the
 * edited row left the filter and the next row slid into its DOM, the new value
 * equalled what that part had last committed, Lit skipped the write, and the box
 * kept showing what the user had typed into the row that was gone.
 *
 * The record underneath was never touched. That is what made it nasty: the grid
 * and the store disagreed, and only a reload said which was right.
 *
 * Keying the rows by id is the fix, so the tests here are all "what does the
 * grid SHOW after a row leaves", checked against what the store HOLDS.
 */

const grid = (page: Page, id: string) => page.locator(`#${panelDomId(id)} data-table`);
const rows = (page: Page, id: string) => grid(page, id).locator('tr[data-row-id]');
/** The n-th data row's cell for column `index`, as an editable box. */
const cell = (page: Page, id: string, row: number, index: number) => rows(page, id).nth(row).locator('td').nth(index).locator('input');

/** The column filter box under a header, by column position. */
const filterBox = (page: Page, id: string, index: number) => grid(page, id).locator('thead input').nth(index);

async function seed(page: Page) {
  const id = await createTable(page, 'Notes', [{ field: 'fieldA' }, { field: 'other' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { fieldA: 'foo', other: 'first' },
    { fieldA: 'foo', other: 'second' },
    { fieldA: 'bar', other: 'third' },
  ]);
  return id;
}

const valuesOf = async (page: Page, id: string, field: string) => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data[field]);

test('a row edited out of the filter does not take the next row’s cell with it', async ({ page }) => {
  const id = await seed(page);

  await filterBox(page, id, 0).fill('foo');
  await expect(rows(page, id)).toHaveCount(2);

  // Clear the TOP row's value. It stops matching, so it leaves — and row two
  // slides into its place in the DOM.
  await cell(page, id, 0, 0).fill('');
  await cell(page, id, 0, 0).blur();

  await expect(rows(page, id)).toHaveCount(1);
  // The row still on screen is the one that was never touched, and it still
  // says what it holds. Before the fix this box was empty.
  await expect(cell(page, id, 0, 0)).toHaveValue('foo');
  await expect(cell(page, id, 0, 1)).toHaveValue('second');

  // And the store agrees: exactly one record lost its value.
  expect((await valuesOf(page, id, 'fieldA')).sort()).toEqual(['', 'bar', 'foo']);
});

test('deleting the row you were typing in does not hand the text to the next one', async ({ page }) => {
  const id = await createTable(page, 'Notes', [{ field: 'other' }]);
  await waitForPanel(page, id);
  // The SAME value in both, which is what arms the trap: after the first row
  // goes, the second row's value equals what that DOM part last committed, so
  // an unkeyed grid decides there is nothing to write.
  await bulkAddRows(page, id, [{ other: 'same' }, { other: 'same' }]);

  // Typed, NOT committed — no blur, so nothing is written and the box simply
  // holds text the store has never seen.
  await cell(page, id, 0, 0).fill('typed');
  // By class, not by role name: the button's accessible name comes from the
  // icon ligature inside it ("delete"), not from its title.
  await rows(page, id).nth(0).locator('button.danger').click();

  await expect(rows(page, id)).toHaveCount(1);
  await expect(cell(page, id, 0, 0)).toHaveValue('same');
  expect(await valuesOf(page, id, 'other')).toEqual(['same']);
});

test('narrowing the filter does not carry a half-typed cell onto the row that remains', async ({ page }) => {
  const id = await createTable(page, 'Notes', [{ field: 'fieldA' }, { field: 'other' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { fieldA: 'foo1', other: 'same' },
    { fieldA: 'foo2', other: 'same' },
  ]);

  await filterBox(page, id, 0).fill('foo');
  await expect(rows(page, id)).toHaveCount(2);

  // Edit the top row, then narrow the filter so that row leaves. Clicking into
  // the filter box blurs the cell, so the edit IS written — to `foo1`, the row
  // that goes away. The row that remains was never touched.
  await cell(page, id, 0, 1).fill('edited foo1');
  await filterBox(page, id, 0).fill('foo2');

  await expect(rows(page, id)).toHaveCount(1);
  await expect(cell(page, id, 0, 0)).toHaveValue('foo2');
  // Before the fix this box read "edited foo1": foo2 had slid into foo1's DOM,
  // and its own value ("same") was what that part had last committed, so the
  // write was skipped and one record's edit was shown on another.
  await expect(cell(page, id, 0, 1)).toHaveValue('same');
  expect((await valuesOf(page, id, 'other')).sort()).toEqual(['edited foo1', 'same']);
});
