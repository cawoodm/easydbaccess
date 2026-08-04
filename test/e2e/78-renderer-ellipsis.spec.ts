import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A cell with no renderer ellipsizes at the COLUMN edge: widen the column and
 * more of the value shows. A `preview` cell used to cut at a fixed 30 characters
 * instead, so a wide column still showed 30 — the auto ellipsis stopped applying
 * the moment a renderer was involved.
 *
 * The cut is CSS again. The character count survives only as a safety cap on how
 * much text goes into the DOM.
 */

const LONG =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua, ut enim ad minim veniam quis nostrud.';

async function previewTable(page: import('@playwright/test').Page, name: string) {
  const id = await createTable(page, name, [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: LONG });
  return id;
}

/** The preview cell's inner text span: what it holds, and whether CSS is clipping it. */
function span(page: import('@playwright/test').Page, id: string) {
  return page
    .locator(`#${panelDomId(id)} data-table`)
    .locator('tbody td preview-cell [title="Click to edit"]');
}

test('a preview cell holds the whole line and lets CSS cut it', async ({ page }) => {
  const id = await previewTable(page, 'Ellipsis');

  // The DOM carries the full one-line text — not 30 characters of it.
  await expect(span(page, id)).toHaveText(LONG);

  // And it is actually being clipped, rather than spilling out of the column.
  const clipped = await span(page, id).evaluate(
    (el) => el.scrollWidth > el.clientWidth && el.clientWidth > 0,
  );
  expect(clipped).toBe(true);
});

test('widening the column shows more of the value, like a plain cell', async ({ page }) => {
  const id = await previewTable(page, 'Widen');
  const cell = span(page, id);

  const narrow = await cell.evaluate((el) => el.clientWidth);
  expect(narrow).toBeGreaterThan(0);

  // Widen the window: the column grows with it, so the visible slice grows too.
  await page.evaluate((d) => {
    const el = document.getElementById(d) as HTMLElement;
    el.style.width = '1100px';
  }, panelDomId(id));

  await expect.poll(() => cell.evaluate((el) => el.clientWidth)).toBeGreaterThan(narrow + 100);
  // Still the same text in the DOM — only the visible part changed.
  await expect(cell).toHaveText(LONG);
});

test('the cap still applies, for a value long enough to need one', async ({ page }) => {
  // 3000 characters is past the 2000-character DOM cap, so the text IS cut —
  // with a real ellipsis character, since CSS is not what did the cutting.
  const id = await createTable(page, 'Capped', [{ field: 'note', renderer: 'preview' }]);
  await waitForPanel(page, id);
  await addRow(page, id, { note: 'x'.repeat(3000) });

  const text = (await span(page, id).textContent()) ?? '';
  expect(text.length).toBeLessThanOrEqual(2001);
  expect(text.endsWith('…')).toBe(true);
});
