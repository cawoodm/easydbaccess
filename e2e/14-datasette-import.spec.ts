import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';

/**
 * Importing an entire Datasette DATABASE (multiple tables) end-to-end.
 *
 * Drives the real UI: the Import header button → the Import dialog (URL entry)
 * → the multi-table picker → the tables landing locally with rows. The three
 * Datasette responses are the actual captures from datasette.io (a database
 * listing + two table responses), served via page.route so no network is hit.
 *
 * The captured responses exercise the real-world quirks this feature handles:
 *  - the database page lists tables with row counts;
 *  - table responses carry a bare column-NAME array (no column_details), so
 *    column types must be refined from the rows;
 *  - `executive_terms` pages via a `next` TOKEN (no next_url) — the importer
 *    must follow it to pull every row, not stop at the first 100.
 */

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/datasette/${name}`, import.meta.url), 'utf8'));

const DB_LISTING = readFixture('legislators.db-listing.json');
const EXECUTIVES = readFixture('executives.json');
const EXECUTIVE_TERMS_PAGE1 = readFixture('executive_terms.json') as {
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

// Synthetic terminating page for executive_terms: rows 101..131 (the real table
// has 131 rows; the captured page 1 holds the first 100 and a `next` token).
const EXECUTIVE_TERMS_PAGE2 = {
  ok: true,
  next: null,
  truncated: false,
  columns: EXECUTIVE_TERMS_PAGE1.columns,
  rows: Array.from({ length: 31 }, (_, i) => ({
    rowid: 101 + i,
    type: i % 2 ? 'viceprez' : 'prez',
    start: '1970-01-20',
    end: '1974-01-20',
    party: 'Independent',
    how: 'election',
    executive_id: 60 + i,
  })),
};

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  // The importer fetches datasette.io cross-origin; a --cors instance answers
  // with this header, so the fulfilled response must carry it too or the
  // browser rejects the fetch.
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});

test.describe('datasette import — whole database', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://datasette.io/**', (route) => {
      const url = new URL(route.request().url());
      switch (url.pathname) {
        case '/legislators.json':
          return route.fulfill(json(DB_LISTING));
        case '/legislators/executives.json':
          return route.fulfill(json(EXECUTIVES));
        case '/legislators/executive_terms.json':
          return route.fulfill(
            json(url.searchParams.get('_next') ? EXECUTIVE_TERMS_PAGE2 : EXECUTIVE_TERMS_PAGE1),
          );
        default:
          return route.fulfill({ status: 404, body: '{"ok":false}' });
      }
    });
  });

  test('lists every table with sizes, then imports the chosen subset with typed columns', async ({
    page,
    workspaceId,
  }) => {
    // Open the Import dialog from the header button (inline import SVG icon).
    await page.getByTitle('Import data from a URL').click();
    const importDialog = page.locator('import-dialog dialog');
    await expect(importDialog).toBeVisible();

    // A database URL (no table segment). "Import as" auto-detects Datasette
    // from the host, so we only need the URL.
    await importDialog.locator('input[type="text"]').fill('https://datasette.io/legislators');
    await importDialog.getByRole('button', { name: 'Import' }).click();

    // The multi-table picker appears, listing all six tables of the database.
    const picker = page.locator('table-select-dialog dialog');
    await expect(picker).toBeVisible();
    await expect(picker.getByText('Choose the tables to import from datasette.io.')).toBeVisible();

    const rows = picker.locator('ul.tables li');
    await expect(rows).toHaveCount(6);
    // Names come from the database listing (asserted on the .name spans — the
    // db name also appears as each row's .detail, so a plain text match would
    // be ambiguous).
    const names = await picker.locator('ul.tables li .name').allInnerTexts();
    expect(names.map((s) => s.trim()).sort()).toEqual([
      'executive_terms',
      'executives',
      'legislator_terms',
      'legislators',
      'offices',
      'social_media',
    ]);
    // Sizes come straight from the database listing's counts.
    const sizes = (await picker.locator('ul.tables li .size').allInnerTexts()).map((s) => s.trim());
    expect(sizes).toContain('80 rows'); // executives
    expect(sizes).toContain('131 rows'); // executive_terms
    expect(sizes.filter((s) => s === '10,001 rows')).toHaveLength(2); // legislators + legislator_terms

    // Everything starts selected.
    const checkboxes = picker.locator('input[type="checkbox"]');
    await expect(checkboxes).toHaveCount(6);
    for (let i = 0; i < 6; i++) await expect(checkboxes.nth(i)).toBeChecked();

    // Narrow to the two tables we have data for: clear, then pick them.
    // Discovery order mirrors the listing: [executive_terms, executives, …].
    await picker.getByRole('button', { name: 'None' }).click();
    await checkboxes.nth(0).check(); // executive_terms
    await checkboxes.nth(1).check(); // executives

    await picker.getByRole('button', { name: /^Import \(2\)$/ }).click();
    await expect(picker).toBeHidden();

    // Wait until both tables have been created locally. (expect.poll awaits the
    // async poller; page.waitForFunction would resolve on the truthy Promise.)
    await expect
      .poll(
        () =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tables = await (window as any).__easydb.store.tables.find();
            return tables
              .filter((t: { workspaceId: string }) => t.workspaceId === ws)
              .map((t: { name: string }) => t.name)
              .sort();
          }, workspaceId),
        { timeout: 15_000 },
      )
      .toEqual(['legislators/executive_terms', 'legislators/executives']);

    // Exactly the two chosen tables were imported — not the whole database.
    const summary = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const tables = (await store.tables.find()).filter(
        (t: { workspaceId: string }) => t.workspaceId === ws,
      );
      const out: Record<string, { rowCount: number; columns: Record<string, string> }> = {};
      for (const t of tables) {
        const rows = await store.rows(t.id).find();
        out[t.name] = {
          rowCount: rows.length,
          columns: Object.fromEntries(
            t.columns.map((c: { field: string; type: string }) => [c.field, c.type]),
          ),
        };
      }
      return { names: tables.map((t: { name: string }) => t.name).sort(), tables: out };
    }, workspaceId);

    expect(summary.names).toEqual(['legislators/executive_terms', 'legislators/executives']);

    // executives: single page, all 80 rows; types refined from the rows even
    // though the schema gave only bare column names.
    const executives = summary.tables['legislators/executives']!;
    expect(executives.rowCount).toBe(80);
    expect(executives.columns.id).toBe('number');
    expect(executives.columns.bio_birthday).toBe('datetime');
    expect(executives.columns.name).toBe('string');

    // executive_terms: paged via the `next` token to pull all 131 rows
    // (100 from page 1 + 31 from the terminating page), not just the first 100.
    const execTerms = summary.tables['legislators/executive_terms']!;
    expect(execTerms.rowCount).toBe(131);
    expect(execTerms.columns.executive_id).toBe('number');
    expect(execTerms.columns.start).toBe('datetime');
    expect(execTerms.columns.type).toBe('string');
  });
});
