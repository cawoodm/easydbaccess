import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The link renderer truncates its display to the column's available width with
 * a pure-CSS ellipsis (the anchor is a min-width:0 flex child), keeping the
 * full value in the title tooltip. A very long URL therefore renders in a box
 * narrower than its content — scrollWidth > clientWidth — instead of blowing
 * the column out to the full URL width.
 */

test('a long link is ellipsized to the column width, full value in the tooltip', async ({
  page,
}) => {
  const longUrl = 'https://example.com/' + 'segment-'.repeat(60) + 'end';

  const tableId = await createTable(page, 'links', [{ field: 'url', renderer: 'link' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { url: longUrl });

  const anchor = page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td cell-link a');
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute('title', `Open ${longUrl}`);

  const box = await anchor.evaluate((a) => ({
    scrollWidth: a.scrollWidth,
    clientWidth: a.clientWidth,
    ellipsis: getComputedStyle(a).textOverflow,
  }));

  // Truncated: the rendered box is narrower than the full text it contains.
  expect(box.ellipsis).toBe('ellipsis');
  expect(box.scrollWidth).toBeGreaterThan(box.clientWidth + 20);
  // …and it stayed bounded by the ~720px panel instead of expanding the column
  // out to the full ~3600px URL width (the pre-fix behaviour).
  expect(box.clientWidth).toBeLessThan(760);
});

/**
 * The link renderer must ACTIVATE when an edit ends, not only when the row is
 * re-read from the store. Typing a URL into a plain-text cell and clicking away
 * left the cell as an <input> — the renderer's own commit updated its internal
 * value, so the host's write-back through the `value` setter saw no change and
 * skipped the repaint. Escape must still cancel: removing a focused input fires
 * a blur, which must not save the edit being cancelled.
 */
test('a URL typed into a cell becomes a link on blur; Escape cancels', async ({ page }) => {
  const tableId = await createTable(page, 'editlinks', [{ field: 'url', renderer: 'link' }]);
  await waitForPanel(page, tableId);
  await addRow(page, tableId, { url: 'plain words' });

  const cell = page.locator(`#${panelDomId(tableId)}`).locator('data-table tbody td cell-link');
  const input = cell.locator('input');
  const anchor = cell.locator('a');

  // Not a link yet — an editable input.
  await expect(input).toBeVisible();
  await expect(anchor).toHaveCount(0);

  // Type a URL, then click away. The cell must become a real link.
  await input.fill('https://example.com/typed');
  await input.blur();
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute('href', 'https://example.com/typed');
  await expect(input).toHaveCount(0);

  // The pencil returns to edit mode; Escape restores the link WITHOUT saving.
  // The renderer focuses the new input on a timer, so wait for that before
  // driving it — otherwise a blur can land before the focus does.
  await cell.locator('button').click();
  await expect(input).toBeFocused();
  await input.fill('https://example.com/DISCARDED');
  await page.keyboard.press('Escape');
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute('href', 'https://example.com/typed');

  // Pencil in and blur with NO edit — the link must come back, not stay an input.
  await cell.locator('button').click();
  await expect(input).toBeFocused();
  await input.blur();
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute('href', 'https://example.com/typed');
});
