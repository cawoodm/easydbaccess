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
