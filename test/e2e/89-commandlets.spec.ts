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

async function openPalette(page: import('@playwright/test').Page) {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await expect(palette).toBeVisible();
  return palette;
}

/** Open the "Run commandlet…" dialog and type into it, without running. */
async function typeInDialog(page: import('@playwright/test').Page, input: string) {
  const palette = await openPalette(page);
  await palette.locator('input').fill('Run commandlet');
  await palette.locator('.item', { hasText: 'Run commandlet' }).first().click();

  const dialog = page.locator('commandlet-dialog');
  const field = dialog.locator('input.commandlet');
  await field.waitFor();
  await field.fill(input);
  return dialog;
}

/** The workspace setting a plain `#anchor` is turned into. */
async function setDefaultCommandlet(page: import('@playwright/test').Page, template: string) {
  await page.evaluate(async (value) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.store.settings.upsert({ name: 'commandlets:default', value });
  }, template);
}

/** Run a commandlet through the palette entry, as a user would. */
async function runViaPalette(page: import('@playwright/test').Page, input: string) {
  const dialog = await typeInDialog(page, input);
  await dialog.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(dialog.locator('dialog')).toBeHidden();
}

test.describe('commandlets', () => {
  test('the palette entry applies a filter to the named table', async ({ page }) => {
    const tableId = await seed(page);

    await runViaPalette(page, 'goto/bible?Book=Matthew');

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Matthew' });
    await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();
  });

  test('a filter clears with an empty value and @clear drops the lot', async ({ page }) => {
    const tableId = await seed(page);

    await runViaPalette(page, 'goto/bible?Book=Matthew&Chapter==5');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Matthew', chapter: '=5' });

    // An empty value removes just that one — a link can widen a view too.
    await runViaPalette(page, 'goto/bible?Chapter=');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Matthew' });

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
        // Written as the real field names, not the labels the commandlet used.
        sortBy: [
          { field: 'chapter', asc: false },
          { field: 'book', asc: true },
        ],
        sortColumn: 'chapter',
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

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Mark' });
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

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: '=Matthew' });
    // The click must not have navigated — the hash stays clean.
    expect(new URL(page.url()).hash).toBe('');
  });

  test('a #hash commandlet runs, clears itself, and works a second time', async ({ page }) => {
    const tableId = await seed(page);

    await page.evaluate(() => {
      location.hash = 'goto/bible?Book=Mark';
    });
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Mark' });
    // Cleared, so clicking the same link again fires hashchange again.
    await expect.poll(() => new URL(page.url()).hash).toBe('');

    await page.evaluate(() => {
      location.hash = 'goto/bible?Book=Matthew';
    });
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Matthew' });
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

  test('cmd/ runs a registered command', async ({ page }) => {
    const tableId = await seed(page);
    await expect(page.locator(`#${panelDomId(tableId)}`)).toBeVisible();

    await runViaPalette(page, 'cmd/windows:close-all');

    await expect(page.locator(`#${panelDomId(tableId)}`)).toHaveCount(0);
  });

  test('a commandlet that arrives without a dialog to vet it toasts why it failed', async ({ page }) => {
    const tableId = await seed(page);

    // A #hash has no dialog in front of it — a stale link is how a bad
    // commandlet reaches the runner, and it must say so rather than throw.
    await page.evaluate(() => {
      location.hash = 'goto/missing?Book=Matthew';
    });

    await expect(page.locator('toast-host')).toContainText('No table called "missing"');
    expect((await readTable(page, tableId)).filters).toBeUndefined();
  });

  test('a column that does not exist is refused, not written', async ({ page }) => {
    const tableId = await seed(page);

    // Writing it would be invisible AND destructive: no funnel exists to clear
    // a filter on a field no column has, and it matches nothing, so the grid
    // would empty with nothing on screen to explain why.
    await page.evaluate(() => {
      location.hash = 'goto/bible?Nonesuch=Matthew';
    });

    await expect(page.locator('toast-host')).toContainText('has no column "Nonesuch"');
    expect((await readTable(page, tableId)).filters).toBeUndefined();
    await expect(page.locator(`#${panelDomId(tableId)} data-table tbody tr`)).toHaveCount(ROWS.length);
  });

  test('a filter names a column by its label or its field, either way', async ({ page }) => {
    const tableId = await seed(page);

    // `Book` is the LABEL; the stored field is `book`. Same rule as a
    // `field:value` search term.
    await runViaPalette(page, 'goto/bible?Book=Mark');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Mark' });

    await runViaPalette(page, 'goto/bible?book=Matthew');
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Matthew' });

    await expect(page.locator(`#${panelDomId(tableId)} data-table tbody tr`)).toHaveCount(2);
  });

  test('the Default commandlet setting gives a plain #anchor a meaning', async ({ page }) => {
    const tableId = await seed(page);
    await setDefaultCommandlet(page, 'goto/bible?Book=$HASH&@sort=-Chapter');

    await page.evaluate(() => {
      location.hash = 'Mark';
    });

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Mark' });
    expect((await readTable(page, tableId)).sortColumn).toBe('chapter');
    // Consumed, so the same anchor can be clicked again.
    await expect.poll(() => new URL(page.url()).hash).toBe('');
  });

  test('$1…$9 split the anchor on /', async ({ page }) => {
    const tableId = await seed(page);
    await setDefaultCommandlet(page, 'goto/bible?Book=$1&Chapter==$2');

    await page.evaluate(() => {
      location.hash = 'Matthew/5';
    });

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Matthew', chapter: '=5' });
  });

  test('an anchor value containing & or ; lands in one field, not two commands', async ({ page }) => {
    const tableId = await createTable(page, 'bible', COLUMNS);
    await bulkAddRows(page, tableId, [{ book: 'Smith & Co; Ltd', chapter: 1 }]);
    await waitForPanel(page, tableId);
    await setDefaultCommandlet(page, 'goto/bible?Book=$HASH');

    await page.evaluate(() => {
      location.hash = encodeURIComponent('Smith & Co; Ltd');
    });

    // Substitution happens AFTER parsing, so the whole string is one filter.
    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Smith & Co; Ltd' });
  });

  test('the palette offers to run text that resembles a commandlet', async ({ page }) => {
    const tableId = await seed(page);
    const palette = await openPalette(page);

    // Matches no command, button or table — but it names a verb.
    await palette.locator('input').fill('goto/bible?Book=Mark');
    const offer = palette.locator('.item', { hasText: 'Run this commandlet' });
    await expect(offer).toHaveCount(1);
    await offer.click();

    await expect.poll(async () => (await readTable(page, tableId)).filters).toEqual({ book: 'Mark' });
  });

  test('the palette does not offer it for ordinary text that matches nothing', async ({ page }) => {
    await seed(page);
    const palette = await openPalette(page);

    await palette.locator('input').fill('zzz nothing matches this');

    await expect(palette.locator('.item')).toHaveCount(0);
  });

  test('the dialog validates as you type and refuses to run a broken commandlet', async ({ page }) => {
    await seed(page);

    const dialog = await typeInDialog(page, 'goto/bible?Book=Mark');
    await expect(dialog.locator('.verdict.ok')).toContainText('open bible');
    await expect(dialog.locator('.verdict.ok')).toContainText('filter book');
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();

    // A table that does not exist is reported before anything runs.
    await dialog.locator('input.commandlet').fill('goto/nope?Book=Mark');
    await expect(dialog.locator('.verdict.bad')).toContainText('No table called "nope"');
    await expect(dialog.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();

    // …so is a column that does not exist.
    await dialog.locator('input.commandlet').fill('goto/bible?Nonesuch=x');
    await expect(dialog.locator('.verdict.bad')).toContainText('has no column "Nonesuch"');

    // …and text that is not a commandlet at all.
    await dialog.locator('input.commandlet').fill('preview/bible');
    await expect(dialog.locator('.verdict.bad')).toContainText('needs 2 targets');
  });

  test('the dialog links to the commandlet guide', async ({ page }) => {
    await seed(page);
    const dialog = await typeInDialog(page, '');

    const help = dialog.locator('a.help');
    await expect(help).toHaveAttribute('href', /docs\/help\/commandlets\.md$/);
    await expect(help).toHaveAttribute('target', '_blank');
  });
});
