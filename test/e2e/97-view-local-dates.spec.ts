import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, waitForPanel } from './helpers.js';

/**
 * A view of a date column showed the value as stored —
 * `2026-06-17T10:59:56.937Z` in a card. With no renderer on the column there was
 * nothing to format it, so a plain `$TOKEN` now formats by the column's TYPE.
 */

async function viewOf(page: import('@playwright/test').Page, ws: string, tableId: string, rowHtml: string, mapping: Record<string, string>) {
  await page.evaluate(
    async ({ ws, tableId, rowHtml, mapping }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const tpl = crypto.randomUUID();
      await store.viewTemplates.insert({ id: tpl, workspaceId: ws, name: 'Cards', headerHtml: '<div>', rowHtml, footerHtml: '</div>', updatedAt: Date.now() });
      await store.viewInstances.insert({
        id: crypto.randomUUID(),
        workspaceId: ws,
        tableId,
        templateId: tpl,
        name: 'Cards',
        filters: {},
        visibleColumns: [],
        mapping,
        open: true,
        updatedAt: Date.now(),
      });
    },
    { ws, tableId, rowHtml, mapping },
  );
}

test('a datetime in a card is local and readable, not the stored ISO string', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Events', [
    { field: 'when', type: 'datetime' },
    { field: 'day', type: 'date' },
  ]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ when: '2026-06-17T10:59:56.937Z', day: '2026-06-17' }]);
  await viewOf(page, workspaceId, id, '<p class="when">$WHEN</p><p class="day">$DAY</p><p class="raw">$raw.WHEN</p>', { WHEN: 'when', DAY: 'day' });

  const vw = page.locator('view-window');
  // The stored spelling is gone from the formatted cells…
  await expect(vw.locator('.when')).not.toContainText('T10:59');
  await expect(vw.locator('.when')).not.toContainText('937');
  await expect(vw.locator('.when')).not.toContainText('Z');
  // …and the reader's own clock is what shows, converted from the instant.
  const expected = await page.evaluate(() => {
    const d = new Date('2026-06-17T10:59:56.937Z');
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
  });
  await expect(vw.locator('.when')).toHaveText(expected);

  // A date-only value keeps its day — the classic off-by-one is what formatting
  // from the parts avoids.
  await expect(vw.locator('.day')).toContainText('17');
  await expect(vw.locator('.day')).not.toContainText('16');

  // `$raw.` is the way back to exactly what is stored.
  await expect(vw.locator('.raw')).toHaveText('2026-06-17T10:59:56.937Z');
});

test('a date column with a renderer is still the renderer’s business', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Events', [{ field: 'when', type: 'datetime', renderer: 'datetime' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ when: '2026-06-17T10:59' }]);
  await viewOf(page, workspaceId, id, '<p class="when">$WHEN</p>', { WHEN: 'when' });

  // The renderer element is mounted, so the type formatting does not apply.
  await expect(page.locator('view-window .when .eda-cell cell-datetime')).toHaveCount(1);
});

test('an unzoned time is not shifted, and an unreadable value survives', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Events', [{ field: 'when', type: 'datetime' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ when: '2026-06-17T09:00' }, { when: 'sometime soon' }]);
  await viewOf(page, workspaceId, id, '<p class="when">$WHEN</p>', { WHEN: 'when' });

  const lines = page.locator('view-window .when');
  await expect(lines).toHaveCount(2);
  // A wall-clock value stays on its own clock wherever it is read…
  await expect(page.locator('view-window')).toContainText('09:00');
  // …and a value the app cannot read is still shown, not blanked.
  await expect(page.locator('view-window')).toContainText('sometime soon');
});
