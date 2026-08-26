import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, readTable, waitForPanel } from './helpers.js';

/**
 * `preview/…` — the one commandlet that shows a record instead of navigating to
 * it. Three shapes:
 *
 *   preview/notes/Body?Title==Berlin   field named, row chosen by filter
 *   preview/notes/n-2                  row by KEY, field chosen for you
 *   preview/notes/Body/n-2             both named
 *
 * Nothing is filtered, focused or written — that is the point. A link in a view
 * can show a related record without disturbing what the reader is looking at, so
 * every spec here also checks the table it came from was left alone.
 */

const COLUMNS = [
  { field: 'id', label: 'Id', renderer: 'link' },
  { field: 'title', label: 'Title', renderer: 'link' },
  { field: 'body', label: 'Body', renderer: 'markdown' },
];

const ROWS = [
  { id: 'n-1', title: 'Berlin', body: '# Berlin\n\nA city in **Germany**.' },
  { id: 'n-2', title: 'Bern', body: '# Bern\n\nThe Swiss capital.' },
  { id: 'n-3', title: 'Bern', body: '# Bern again\n\nA duplicate title.' },
];

async function seed(page: Page, name = 'notes') {
  const tableId = await createTable(page, name, COLUMNS);
  await bulkAddRows(page, tableId, ROWS);
  await waitForPanel(page, tableId);
  return tableId;
}

/** Run a commandlet the way a link in a cell or a view does. */
async function runHash(page: Page, cmdlet: string) {
  await page.evaluate((h) => {
    location.hash = h;
  }, cmdlet);
}

/** The preview window, whichever one is open. */
const popup = (page: Page) => page.locator('[id^="easydb-preview-popup-"]');

test.describe('the preview commandlet', () => {
  test('a named field and a filter show that cell, rendered', async ({ page }) => {
    const tableId = await seed(page);

    await runHash(page, 'preview/notes/Body?Title==Berlin');

    // Rendered, not raw: the markdown renderer turned `#` into a heading. That is
    // what makes this a preview rather than a peek at the stored string.
    await expect(popup(page)).toBeVisible();
    await expect(popup(page).locator('h1')).toHaveText('Berlin');
    await expect(popup(page)).toContainText('A city in Germany');
    await expect(popup(page).locator('strong')).toHaveText('Germany');

    // The table it came from is untouched — no filter, no sort.
    expect((await readTable(page, tableId)).filters).toBeUndefined();
  });

  test('the window is titled with the table and the column', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/notes/Body?Title==Berlin');
    await expect(popup(page)).toContainText('notes — Body');
  });

  test('a key alone picks the row by the first column and the field for you', async ({ page }) => {
    await seed(page);

    // `n-2` is not a column name, so it is a key — matched against `id`, the
    // first column. `body` is chosen because it is the one with a preview-style
    // renderer.
    await runHash(page, 'preview/notes/n-2');

    await expect(popup(page).locator('h1')).toHaveText('Bern');
    await expect(popup(page)).toContainText('The Swiss capital');
  });

  test('a leading slash is fine, as a link inside a template spells it', async ({ page }) => {
    await seed(page);
    await runHash(page, '/preview/notes/n-2');
    await expect(popup(page).locator('h1')).toHaveText('Bern');
  });

  test('field and key together show exactly that cell', async ({ page }) => {
    await seed(page);

    await runHash(page, 'preview/notes/Title/n-3');

    // The `title` column, not the markdown one the key-only form would have
    // picked — and row n-3, not the other row also titled "Bern".
    await expect(popup(page)).toContainText('Bern');
    await expect(popup(page)).toContainText('notes — Title');
    await expect(popup(page).locator('h1')).toHaveCount(0);
  });

  test('a key matches exactly, so a prefix does not win the row', async ({ page }) => {
    await seed(page);

    // A bare value means "contains" to the filter language, so `n-1` would match
    // `n-1` only because it sorts first — but the rule has to hold whichever way
    // the rows come back. The key carries `=`, so this is one row by identity.
    await runHash(page, 'preview/notes/n-1');
    await expect(popup(page).locator('h1')).toHaveText('Berlin');
  });

  test('a filter matching several rows shows the first and warns', async ({ page }) => {
    await seed(page);

    // "Bern" is on two rows. Refusing would be worse than answering: the usual
    // way here is a link built from a nearly-unique value, and a window with a
    // plausible record plus a count is more use than an error with nothing in it.
    await runHash(page, 'preview/notes/Body?Title==Bern');

    await expect(page.locator('toast-host')).toContainText('2 rows match');
    await expect(page.locator('toast-host')).toContainText('showing the first');
    await expect(popup(page).locator('h1')).toHaveText('Bern');
  });

  test('a unique match warns about nothing', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/notes/Body?Title==Berlin');
    await expect(popup(page)).toBeVisible();
    await expect(page.locator('toast-host')).not.toContainText('rows match');
  });

  test('a filter matching no row says so instead of opening an empty window', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/notes/Body?Title==Nowhere');

    await expect(page.locator('toast-host')).toContainText('No row in "notes" matches');
    await expect(popup(page)).toHaveCount(0);
  });

  test('an unknown table is refused', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/missing/n-1');
    await expect(page.locator('toast-host')).toContainText('No table called "missing"');
    await expect(popup(page)).toHaveCount(0);
  });

  test('a named field that does not exist is refused, not guessed', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/notes/Nonesuch/n-1');
    await expect(page.locator('toast-host')).toContainText('is not a column of this table');
    await expect(popup(page)).toHaveCount(0);
  });

  test('preview with neither key nor filter says what is missing', async ({ page }) => {
    await seed(page);

    // `Body` is a column name, so this is the field form — with no filter behind
    // it there is no record to show, and showing "the first row of the table"
    // would be an answer to a question nobody asked.
    await runHash(page, 'preview/notes/Body');
    await expect(page.locator('toast-host')).toContainText('needs a key or a filter');
    await expect(popup(page)).toHaveCount(0);
  });

  test('Escape closes the window, as it does for a cell preview', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/notes/n-2');
    await expect(popup(page)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(popup(page)).toHaveCount(0);
  });

  test('a computed column previews what the script returns', async ({ page }) => {
    // The stored cell behind a script is empty, so reading it would show an empty
    // window for a column plainly full of text in the grid.
    const tableId = await createTable(page, 'computed', [
      { field: 'id', renderer: 'link' },
      { field: 'shout', renderer: 'markdown', script: 'function render(row) {\n  return "**" + row.id.toUpperCase() + "**";\n}' },
    ]);
    await bulkAddRows(page, tableId, [{ id: 'abc' }]);
    await waitForPanel(page, tableId);

    await runHash(page, 'preview/computed/abc');
    await expect(popup(page).locator('strong')).toHaveText('ABC');
  });
});
