import { test, expect } from './fixtures.js';
import { panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A dump whose ROWS carry a field its own column list omits.
 *
 * `bible.db.json` is the real case: it declares `book` and no `title`, and 368 of its
 * 1,258 rows carry `title` instead of `book` — one logical field under two names,
 * written by two generations of the exporter. Those 368 rows imported blank. The
 * value was in the row the whole time with no column to show it, so it could not be
 * sorted, filtered, searched or even seen — there was nothing on screen to say the
 * data had arrived at all.
 */

/** Injects a synthetic file-drop into the drop handler registry. */
async function dropFile(page: import('@playwright/test').Page, filename: string, text: string) {
  await page.evaluate(
    async ({ filename, text }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const file = new File([text], filename, { type: 'application/json' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      for (const fn of ctx.registries.dropHandlers) {
        if (await fn(event, ctx.api)) break;
      }
    },
    { filename, text },
  );
}

/** A one-table dump shaped like the bible one: two names for the same field. */
const dump = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    workspaceId: 'whatever',
    exportedAt: 1,
    tables: [
      {
        name: 'verses',
        columns: [
          { field: 'book', label: 'Book', type: 'string', width: 270 },
          { field: 'text', label: 'Text', type: 'string' },
        ],
        rows: [
          { book: 'Genesis 1', text: 'In the beginning' },
          { title: 'Psalms 50', text: 'The Mighty One' },
          { title: 'Psalms 51', text: 'Have mercy' },
        ],
        ...extra,
      },
    ],
  });

const tableNamed = (page: import('@playwright/test').Page, name: string) =>
  page.evaluate(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (n) => (await (window as any).__easydb.store.tables.find()).find((t: { name: string }) => t.name === n) ?? null,
    name,
  );

test('a field only the rows carry gets a column, so it is visible at all', async ({ page }) => {
  await dropFile(page, 'verses.db.json', dump());

  await expect.poll(async () => (await tableNamed(page, 'verses')) !== null, { timeout: 10_000 }).toBe(true);
  const t = (await tableNamed(page, 'verses')) as { id: string; columns: Array<{ field: string; label: string; type: string; width?: number }> };

  // Appended, never inserted: the declared order is the user's, and a declared
  // column carries width, renderer and the rest.
  expect(t.columns.map((c) => c.field)).toEqual(['book', 'text', 'title']);
  expect(t.columns[0]).toMatchObject({ field: 'book', label: 'Book', width: 270 });
  expect(t.columns[2]).toMatchObject({ field: 'title', type: 'string' });

  // The rows kept their values — the fix is about the schema, not the data.
  const rows = (await readRows(page, t.id)) as Array<{ data: Record<string, unknown> }>;
  expect(rows).toHaveLength(3);
  expect(rows.filter((r) => r.data.title === 'Psalms 50')).toHaveLength(1);

  // And it is on screen: a header for it, and the value in a cell. The cell content
  // is read from the DOM rather than matched as text, because `auto-renderer` gives a
  // string column the `link` renderer on import and that renders an `<input>`, whose
  // value is a property and not text.
  await waitForPanel(page, t.id);
  const grid = page.locator(`#${panelDomId(t.id)} data-table`);
  await expect(grid.locator('th', { hasText: 'title' })).toHaveCount(1);
  await expect
    .poll(
      () =>
        page.evaluate((domId) => {
          const root = document.getElementById(domId)?.querySelector('data-table')?.shadowRoot;
          const cells = Array.from(root?.querySelectorAll('tbody tr:not(.spacer) td') ?? []);
          return cells.map((td) => (td.querySelector('input') as HTMLInputElement | null)?.value ?? td.textContent?.trim() ?? '');
        }, panelDomId(t.id)),
      { timeout: 10_000 },
    )
    .toContain('Psalms 50');
});

test('a column the user deleted stays deleted', async ({ page }) => {
  // `deletedColumns` is what tells a deletion apart from an omission. Without it a
  // removed column would come back on every round trip, since the rows still hold
  // its values.
  await dropFile(page, 'verses.db.json', dump({ deletedColumns: ['title'] }));

  await expect.poll(async () => (await tableNamed(page, 'verses')) !== null, { timeout: 10_000 }).toBe(true);
  const t = (await tableNamed(page, 'verses')) as { columns: Array<{ field: string }>; deletedColumns?: string[] };
  expect(t.columns.map((c) => c.field)).toEqual(['book', 'text']);
  expect(t.deletedColumns).toEqual(['title']);
});
