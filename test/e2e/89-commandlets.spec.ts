import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * Commandlets: one URL-shaped string — `goto/bible?Book=Matthew` — run from a
 * `?cmdlet=` deep link, a `#hash`, a link inside a cell, or the palette.
 *
 * The boot entry points wait for the window managers (`windows-ready.ts`), so a
 * deep link reveals a window that actually exists; these specs would flake
 * without that and pass with it.
 */

const COLUMNS = [
  { field: 'book', label: 'Book', renderer: 'link' },
  { field: 'chapter', label: 'Chapter', type: 'number' as const },
];

const ROWS = [
  { book: 'Matthew', chapter: 5 },
  { book: 'Matthew', chapter: 6 },
  { book: 'Mark', chapter: 1 },
];

async function seed(page: import('@playwright/test').Page, name = 'bible') {
  const tableId = await createTable(page, name, COLUMNS);
  await bulkAddRows(page, tableId, ROWS);
  await waitForPanel(page, tableId);
  return tableId;
}

/** Run a commandlet through the palette entry, as a user would. */
async function runViaPalette(page: import('@playwright/test').Page, input: string) {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('Run commandlet');
  await palette.locator('.item', { hasText: 'Run commandlet' }).first().click();

  const dialogs = page.locator('host-dialogs');
  const field = dialogs.locator('input[type="text"]').first();
  await field.waitFor();
  await field.fill(input);
  await dialogs.getByRole('button', { name: 'OK', exact: true }).click();
}

test.describe('commandlets', () => {
  test('the palette entry applies a filter to the named table', async ({ page }) => {
    const tableId = await seed(page);

    await runViaPalette(page, 'goto/bible?Book=Matthew');

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: 'Matthew' });
    await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();
  });

  test('a filter clears with an empty value and @clear drops the lot', async ({ page }) => {
    const tableId = await seed(page);

    await runViaPalette(page, 'goto/bible?Book=Matthew&Chapter==5');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: 'Matthew', Chapter: '=5' });

    // An empty value removes just that one — a link can widen a view too.
    await runViaPalette(page, 'goto/bible?Chapter=');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: 'Matthew' });

    await runViaPalette(page, 'goto/bible?@clear=1');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toBeUndefined();
  });

  test('@sort writes the sort keys and mirrors the first one', async ({ page }) => {
    const tableId = await seed(page);

    await runViaPalette(page, 'goto/bible?@sort=-Chapter,Book');

    await expect
      .poll(async () => {
        const t = await readTable(page, tableId);
        return { sortBy: t.sortBy, sortColumn: t.sortColumn, sortAsc: t.sortAsc };
      })
      .toEqual({
        sortBy: [
          { field: 'Chapter', asc: false },
          { field: 'Book', asc: true },
        ],
        sortColumn: 'Chapter',
        sortAsc: false,
      });
  });

  test('a ?cmdlet= deep link runs once the windows are restored', async ({ page, workspaceId }) => {
    const tableId = await seed(page);

    const cmdlet = encodeURIComponent('goto/bible?Book=Mark');
    await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}&cmdlet=${cmdlet}`);
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
      { timeout: 15_000 },
    );

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: 'Mark' });
    await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();
  });

  test('a link in a cell runs its commandlet and resolves $TABLE from the click', async ({ page }) => {
    const tableId = await createTable(page, 'bible', [
      ...COLUMNS,
      // The script builds the href with the helper, so the value is encoded for
      // it; `$TABLE` is filled in from wherever the link is clicked.
      {
        field: 'jump',
        label: 'Jump',
        // The `html` renderer injects what the script returns; the script itself
        // only builds the href.
        renderer: 'html',
        script: "function render(row) { return `<a href=\"${easydb.cmdlet('goto/$TABLE', { Book: '=' + row.book })}\">go</a>`; }",
      },
    ]);
    // One row only: with several, which link `.first()` picks depends on the
    // grid's row order, and this spec is about the click, not the ordering.
    await bulkAddRows(page, tableId, [{ book: 'Matthew', chapter: 5 }]);
    await waitForPanel(page, tableId);

    await page
      .locator(`#${panelDomId(tableId)} data-table`)
      .getByRole('link', { name: 'go' })
      .click();

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: '=Matthew' });
    // The click must not have navigated — the hash stays clean.
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a #hash commandlet runs, clears itself, and works a second time', async ({ page }) => {
    const tableId = await seed(page);

    await page.evaluate(() => {
      location.hash = 'goto/bible?Book=Mark';
    });
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: 'Mark' });
    // Cleared, so clicking the same link again fires hashchange again.
    await expect.poll(() => new URL(page.url()).hash).toBe('');

    await page.evaluate(() => {
      location.hash = 'goto/bible?Book=Matthew';
    });
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ Book: 'Matthew' });
  });

  test('a plain #anchor is left alone', async ({ page }) => {
    const tableId = await seed(page);

    await page.evaluate(() => {
      location.hash = 'Matthew';
    });
    await page.waitForTimeout(300);

    expect(new URL(page.url()).hash).toBe('#Matthew');
    expect((await readTable(page, tableId)).filters).toBeUndefined();
  });

  test('cmd/ runs a registered command and an unknown one toasts', async ({ page }) => {
    const tableId = await seed(page);
    await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();

    await runViaPalette(page, 'cmd/windows:close-all');
    await expect(page.locator(`#${panelDomId(tableId)}`)).toHaveCount(0);

    await runViaPalette(page, 'cmd/nope:nothing');
    await expect(page.locator('toast-host')).toContainText('No command with id');
  });

  test('an unknown table name toasts instead of throwing', async ({ page }) => {
    await seed(page);

    await runViaPalette(page, 'goto/missing?Book=Matthew');

    await expect(page.locator('toast-host')).toContainText('No table called "missing"');
  });
});
