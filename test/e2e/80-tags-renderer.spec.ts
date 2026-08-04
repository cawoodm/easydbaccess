import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The `tags` cell renderer: one pill per value of an `array` column. In a plain
 * input a list is one long string with no visible boundary between its values.
 *
 * The pills read the cell, they do not rewrite it — a comma list, a JSON array
 * and a real array all show the same pills, and the pencil opens the raw list so
 * an edit cannot silently change one spelling into the other.
 */

async function tagsTable(page: import('@playwright/test').Page, name: string) {
  const id = await createTable(page, name, [
    { field: 'name' },
    { field: 'tags', type: 'array', renderer: 'tags' },
  ]);
  await waitForPanel(page, id);
  return id;
}

function pills(page: import('@playwright/test').Page, id: string, row = 0) {
  return page
    .locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`)
    .nth(row)
    .locator('cell-tags .tag-pill');
}

test('each value of the list gets its own pill', async ({ page }) => {
  const id = await tagsTable(page, 'Pills');
  await addRow(page, id, { name: 'a', tags: 'red,blue,green' });

  await expect(pills(page, id)).toHaveCount(3);
  await expect(pills(page, id).nth(0)).toHaveText('red');
  await expect(pills(page, id).nth(1)).toHaveText('blue');
  await expect(pills(page, id).nth(2)).toHaveText('green');
});

test('a JSON array and a real array show the same pills', async ({ page }) => {
  const id = await tagsTable(page, 'Spellings');
  await addRow(page, id, { name: 'a', tags: '["Red", "Blue"]' });
  await addRow(page, id, { name: 'b', tags: ['Red', 'Blue'] });

  await expect(pills(page, id, 0)).toHaveText(['Red', 'Blue']);
  await expect(pills(page, id, 1)).toHaveText(['Red', 'Blue']);
});

test('a list with no values shows no pills at all', async ({ page }) => {
  const id = await tagsTable(page, 'Empty');
  await addRow(page, id, { name: 'a', tags: '[]' });
  await addRow(page, id, { name: 'b', tags: null });

  await expect(pills(page, id, 0)).toHaveCount(0);
  await expect(pills(page, id, 1)).toHaveCount(0);
});

test('the pencil edits the raw list, and the pills follow the new value', async ({ page }) => {
  const id = await tagsTable(page, 'Edit');
  await addRow(page, id, { name: 'a', tags: '["Red","Blue"]' });

  const cell = page.locator(`#${panelDomId(id)} data-table tbody cell-tags`).first();
  await cell.locator('button').click();
  // The editor holds the value as STORED, not the pills' text.
  const input = cell.locator('input');
  await expect(input).toHaveValue('["Red","Blue"]');

  await input.fill('Red,Blue,Green');
  await input.press('Enter');
  await expect(pills(page, id)).toHaveText(['Red', 'Blue', 'Green']);

  // And the store has the text that was typed.
  const stored = await page.evaluate(async (tableId) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = await ctx.store.rows(tableId).find();
    return rows[0]?.data?.tags;
  }, id);
  expect(stored).toBe('Red,Blue,Green');
});

test('Escape leaves the edit unsaved', async ({ page }) => {
  const id = await tagsTable(page, 'Cancel');
  await addRow(page, id, { name: 'a', tags: 'red' });

  const cell = page.locator(`#${panelDomId(id)} data-table tbody cell-tags`).first();
  await cell.locator('button').click();
  await cell.locator('input').fill('blue');
  await cell.locator('input').press('Escape');

  await expect(pills(page, id)).toHaveText(['red']);
});
