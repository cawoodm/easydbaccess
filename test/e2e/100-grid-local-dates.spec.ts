import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A datetime carrying a zone names an INSTANT, so the grid and the `datetime`
 * renderer have to convert it to the reader's clock. They used to strip the zone
 * instead: `2026-06-17T10:59:56.937Z` went into the picker as 10:59, which is the
 * wrong time anywhere but UTC — and the next edit saved that wrong time.
 *
 * Views have formatted locally since 0.0.335; this is the grid catching up, and
 * both now read the one rule in `util/local-datetime.ts`.
 */

/** The instant above as the browser's own clock spells it. */
const localParts = (page: import('@playwright/test').Page, iso: string) =>
  page.evaluate((s) => {
    const d = new Date(s);
    const pad = (n: number) => String(n).padStart(2, '0');
    return {
      input: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`,
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      text: `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    };
  }, iso);

const ZONED = '2026-06-17T10:59:56.937Z';

test('the grid puts a zoned datetime in the picker on the reader’s clock', async ({ page }) => {
  const id = await createTable(page, 'Events', [
    { field: 'when', type: 'datetime' },
    { field: 'day', type: 'date' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ when: ZONED, day: ZONED }]);

  const want = await localParts(page, ZONED);
  const panel = page.locator(`#${panelDomId(id)}`);
  await expect(panel.locator('input[type="datetime-local"]')).toHaveValue(want.input);
  await expect(panel.locator('input[type="date"]')).toHaveValue(want.date);
});

test('an unzoned datetime is left on its own clock, and a date keeps its day', async ({ page }) => {
  const id = await createTable(page, 'Events', [
    { field: 'when', type: 'datetime' },
    { field: 'day', type: 'date' },
  ]);
  await waitForPanel(page, id);
  // A meeting stored as 09:00 is at 09:00 wherever it is read; a date-only value
  // must not slide to the 16th west of Greenwich.
  await bulkAddRows(page, id, [{ when: '2026-06-17 09:00:30', day: '2026-06-17' }]);

  const panel = page.locator(`#${panelDomId(id)}`);
  await expect(panel.locator('input[type="datetime-local"]')).toHaveValue('2026-06-17T09:00');
  await expect(panel.locator('input[type="date"]')).toHaveValue('2026-06-17');
});

test('the datetime renderer shows a zoned value locally when it cannot be edited', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Events', [{ field: 'when', type: 'datetime', renderer: 'datetime' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ when: ZONED }]);

  // Read-only is where the renderer prints text rather than mounting a picker.
  await page.evaluate(
    async ({ id }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__easydb.store.tables.patch(id, { readonly: true, updatedAt: Date.now() });
    },
    { id, workspaceId },
  );

  const want = await localParts(page, ZONED);
  const cell = page.locator(`#${panelDomId(id)} cell-datetime`);
  await expect(cell).toHaveText(want.text);
  // The stored spelling is gone: no seconds, no milliseconds, no Z.
  await expect(cell).not.toContainText('937');
  await expect(cell).not.toContainText('Z');
});
