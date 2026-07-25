import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures.js';
import { panelDomId } from './helpers.js';

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

  test('the sample dropdown offers the datasette.io instance root, not power plants', async ({
    page,
  }) => {
    await page.getByTitle('Import data from a URL').click();
    const dialog = page.locator('import-dialog dialog');
    await expect(dialog).toBeVisible();

    const presets = dialog.locator('select').first();
    const labels = (await presets.locator('option').allTextContents()).map((s) => s.trim());
    const joined = labels.join(' | ');
    expect(joined).toContain('datasette.io');
    expect(joined.toLowerCase()).not.toContain('power');

    // Choosing it fills the URL box with the bare instance root.
    const dsValue = await presets
      .locator('option', { hasText: 'datasette.io' })
      .getAttribute('value');
    await presets.selectOption(dsValue!);
    await expect(dialog.locator('input[type="text"]').first()).toHaveValue('https://datasette.io');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
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
    await expect(picker.getByText('Choose tables to import from datasette.io.')).toBeVisible();

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

    // Windows are created up front (empty), then filled — so wait until the
    // ROWS have actually landed, not just the table records. (expect.poll awaits
    // the async poller; page.waitForFunction would resolve on the truthy Promise.)
    await expect
      .poll(
        () =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const store = (window as any).__easydb.store;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const tables = (await store.tables.find()).filter(
              (t: { workspaceId: string }) => t.workspaceId === ws,
            );
            const counts: Record<string, number> = {};
            for (const t of tables) counts[t.name] = (await store.rows(t.id).find()).length;
            return counts;
          }, workspaceId),
        { timeout: 15_000 },
      )
      .toEqual({ 'legislators/executive_terms': 131, 'legislators/executives': 80 });

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

  test('an imported table records its origin and the Refresh button re-pulls it', async ({
    page,
    workspaceId,
  }) => {
    // Override the suite route with a controllable single-table database.
    let people = [{ id: 1, name: 'Alice' }];
    await page.route('https://datasette.io/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/mini.json')
        return route.fulfill(
          json({
            ok: true,
            tables: [{ name: 'people', count: people.length, primary_keys: ['id'] }],
          }),
        );
      if (u.pathname === '/mini/people.json') {
        if ((u.searchParams.get('_extra') ?? '').includes('columns'))
          return route.fulfill(json({ ok: true, columns: ['id', 'name'], rows: [] }));
        return route.fulfill(json({ ok: true, next: null, rows: people }));
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    await page.getByTitle('Import data from a URL').click();
    const importDialog = page.locator('import-dialog dialog');
    await importDialog.locator('input[type="text"]').fill('https://datasette.io/mini');
    await importDialog.getByRole('button', { name: 'Import' }).click();
    await page
      .locator('table-select-dialog dialog')
      .getByRole('button', { name: /^Import \(1\)$/ })
      .click();

    const tableId: string = await (async () => {
      await expect
        .poll(() =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ts = await (window as any).__easydb.store.tables.find();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return ts.some((t: any) => t.workspaceId === ws && t.name === 'mini/people');
          }, workspaceId),
        )
        .toBe(true);
      return page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = await (window as any).__easydb.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ts.find((t: any) => t.workspaceId === ws && t.name === 'mini/people').id;
      }, workspaceId);
    })();

    // The snapshot records where to re-pull from (not a live `source`).
    const rec = await page.evaluate(async (id) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = await (window as any).__easydb.store.tables.findOne(id);
      return { origin: t.origin, hasSource: t.source != null };
    }, tableId);
    expect(rec).toEqual({
      origin: { type: 'datasette', url: 'https://datasette.io/mini/people' },
      hasSource: false,
    });

    const footer = page.locator(`#${panelDomId(tableId)} panel-footer`);
    await expect(footer).toContainText('1 row');

    // Backend gains a row; Refresh re-fetches and replaces the local snapshot.
    people = [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
    ];
    await footer.getByRole('button', { name: 'Refresh' }).click();
    await expect(footer).toContainText('2 rows');
  });

  test('a single-table import shows a proportional (determinate) progress bar', async ({
    page,
    workspaceId,
  }) => {
    // datasette.io omits `count` from schema responses, so a single-table import
    // must fetch `?_extra=count` to get a denominator. Two pages, the second
    // delayed, so the determinate 50% bar is observable mid-import.
    await page.route('https://datasette.io/**', async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname !== '/mini/people.json')
        return route.fulfill({ status: 404, body: '{"ok":false}' });
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra === 'column_details')
        return route.fulfill(json({ ok: true, next: null, rows: [] }));
      if (extra === 'columns')
        return route.fulfill(json({ ok: true, columns: ['id', 'name'], rows: [] }));
      if (extra === 'count') return route.fulfill(json({ ok: true, count: 4, rows: [] }));
      if (u.searchParams.get('_next') === '2') {
        await new Promise((r) => setTimeout(r, 1200)); // delay page 2
        return route.fulfill(
          json({
            ok: true,
            next: null,
            rows: [
              { id: 3, name: 'C' },
              { id: 4, name: 'D' },
            ],
          }),
        );
      }
      return route.fulfill(
        json({
          ok: true,
          next: '2',
          rows: [
            { id: 1, name: 'A' },
            { id: 2, name: 'B' },
          ],
        }),
      );
    });

    await page.getByTitle('Import data from a URL').click();
    const dlg = page.locator('import-dialog dialog');
    await dlg.locator('input[type="text"]').fill('https://datasette.io/mini/people');
    await dlg.getByRole('button', { name: 'Import', exact: true }).click();

    const tableId: string = await (async () => {
      await expect
        .poll(() =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ts = await (window as any).__easydb.store.tables.find();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return ts.some((t: any) => t.workspaceId === ws && t.name === 'mini/people');
          }, workspaceId),
        )
        .toBe(true);
      return page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = await (window as any).__easydb.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ts.find((t: any) => t.workspaceId === ws && t.name === 'mini/people').id;
      }, workspaceId);
    })();

    // After page 1 (2 of 4 rows) the bar is DETERMINATE at ~50% — visible while
    // page 2 is still in flight (not the indeterminate "waiting" sliver).
    const determinate = page.locator(`#${panelDomId(tableId)} .load-bar-fill.determinate`);
    await expect(determinate).toBeVisible({ timeout: 4000 });
    await expect(page.locator(`#${panelDomId(tableId)} [role="progressbar"]`)).toHaveAttribute(
      'aria-valuenow',
      '50',
    );

    // Import completes with all 4 rows.
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (await (window as any).__easydb.store.rows(id).find()).length;
        }, tableId),
      )
      .toBe(4);
  });

  test('an imported Datasette table shows the (i) info button with its source', async ({
    page,
    workspaceId,
  }) => {
    // Single-table db; the metadata endpoint 404s (as on datasette.io 1.0), so
    // there is no curated description — the (i) button must still appear,
    // carrying where the table came from.
    await page.route('https://datasette.io/**', (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === '/mini.json')
        return route.fulfill(
          json({ ok: true, tables: [{ name: 'people', count: 1, primary_keys: ['id'] }] }),
        );
      if (u.pathname === '/mini/people.json') {
        if ((u.searchParams.get('_extra') ?? '').includes('columns'))
          return route.fulfill(json({ ok: true, columns: ['id', 'name'], rows: [] }));
        return route.fulfill(json({ ok: true, next: null, rows: [{ id: 1, name: 'Alice' }] }));
      }
      return route.fulfill({ status: 404, body: '{"ok":false}' });
    });

    await page.getByTitle('Import data from a URL').click();
    const importDialog = page.locator('import-dialog dialog');
    await importDialog.locator('input[type="text"]').fill('https://datasette.io/mini');
    await importDialog.getByRole('button', { name: 'Import' }).click();
    await page
      .locator('table-select-dialog dialog')
      .getByRole('button', { name: /^Import \(1\)$/ })
      .click();

    // Wait for the import to stamp `info.sourceUrl` on the table.
    const tableId: string = await (async () => {
      await expect
        .poll(() =>
          page.evaluate(async (ws) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ts = await (window as any).__easydb.store.tables.find();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const t = ts.find((x: any) => x.workspaceId === ws && x.name === 'mini/people');
            return t?.info?.sourceUrl ?? null;
          }, workspaceId),
        )
        .toBe('https://datasette.io/mini/people');
      return page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = await (window as any).__easydb.store.tables.find();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return ts.find((t: any) => t.workspaceId === ws && t.name === 'mini/people').id;
      }, workspaceId);
    })();

    // The titlebar (i) button is now shown; clicking it opens the info dialog
    // with a link to the source table.
    const infoBtn = page.locator(`#${panelDomId(tableId)} .eda-info-btn`);
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();
    const infoDlg = page.locator('table-info-dialog dialog');
    await expect(infoDlg).toBeVisible();
    await expect(infoDlg.locator('a[href="https://datasette.io/mini/people"]')).toBeVisible();
  });

  const importExecutives = async (page: import('@playwright/test').Page) => {
    await page.getByTitle('Import data from a URL').click();
    const dialog = page.locator('import-dialog dialog');
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="text"]').fill('https://datasette.io/legislators/executives');
    await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  };

  const countNamed = (page: import('@playwright/test').Page, ws: string, name: string) =>
    page.evaluate(
      async ({ ws, name }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (await store.tables.find()).filter(
          (t: any) => t.workspaceId === ws && t.name === name,
        ).length;
      },
      { ws, name },
    );

  test('importing a single table shows exactly one toast', async ({ page, workspaceId }) => {
    await importExecutives(page);
    await expect.poll(() => countNamed(page, workspaceId, 'legislators/executives')).toBe(1);
    // Previously two toasts appeared (generic per-table + datasette summary);
    // now datasette owns the message, so exactly one shows.
    await expect(page.locator('toast-host .toast')).toHaveCount(1);
  });

  test('re-importing an existing table offers overwrite / rename', async ({
    page,
    workspaceId,
  }) => {
    await importExecutives(page);
    await expect.poll(() => countNamed(page, workspaceId, 'legislators/executives')).toBe(1);

    // Second import collides → the choice dialog gives feedback + the switch.
    await importExecutives(page);
    const choice = page.locator('host-dialogs dialog');
    await expect(choice).toBeVisible();
    await expect(choice).toContainText('already exists');

    // Overwrite replaces in place — still exactly one table of that name.
    await choice.getByRole('button', { name: 'Overwrite' }).click();
    await expect.poll(() => countNamed(page, workspaceId, 'legislators/executives')).toBe(1);

    // Third import → Rename → a distinct "… (2)" table is created.
    await importExecutives(page);
    await expect(page.locator('host-dialogs dialog')).toBeVisible();
    await page.locator('host-dialogs dialog').getByRole('button', { name: 'Rename' }).click();
    await expect.poll(() => countNamed(page, workspaceId, 'legislators/executives (2)')).toBe(1);
  });
});

/**
 * Instance-root URL: the Import dialog lists the instance's databases inline so
 * the user picks one BEFORE the table picker. Selecting a database narrows the
 * import to that database's tables (no cross-database modal db picker).
 */
test.describe('datasette import — instance-root database picker', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('https://inst.example/**', (route) => {
      const url = new URL(route.request().url());
      switch (url.pathname) {
        case '/-/databases.json':
          return route.fulfill(
            json({
              ok: true,
              databases: [
                { name: '_memory', route: '_memory', is_memory: true }, // skipped
                { name: 'sales', route: 'sales' },
                { name: 'hr', route: 'hr' },
              ],
            }),
          );
        case '/sales.json':
          return route.fulfill(
            json({ ok: true, tables: [{ name: 'orders', count: 2, primary_keys: ['id'] }] }),
          );
        case '/sales/orders.json':
          if (url.searchParams.get('_extra') === 'columns')
            return route.fulfill(json({ ok: true, columns: ['id', 'total'], rows: [] }));
          return route.fulfill(
            json({
              ok: true,
              next: null,
              rows: [
                { id: 1, total: 10 },
                { id: 2, total: 20 },
              ],
            }),
          );
        default:
          return route.fulfill({ status: 404, body: '{"ok":false}' });
      }
    });
  });

  test('picking a database imports its tables directly, skipping the table picker', async ({
    page,
    workspaceId,
  }) => {
    await page.getByTitle('Import data from a URL').click();
    const dlg = page.locator('import-dialog dialog');
    await expect(dlg).toBeVisible();

    // A bare instance root. Force the Datasette kind so the picker shows even
    // though the host isn't literally "datasette".
    await dlg.locator('input[type="text"]').fill('https://inst.example');
    await dlg.locator('select').last().selectOption('datasette');

    // The Database row appears; load the list.
    await dlg.getByRole('button', { name: 'List databases' }).click();
    const dbSelect = dlg.locator('.db-row select');
    // _memory is skipped; the two real databases are offered (plus the "all" row).
    await expect(dbSelect.locator('option')).toHaveText([/all databases/, 'sales', 'hr']);

    // Pick "sales" and import. Because a specific db was chosen, the table
    // checklist is skipped entirely — the db's tables import directly.
    await dbSelect.selectOption('sales');
    await dlg.getByRole('button', { name: 'Import', exact: true }).click();

    // The table-select dialog must NOT appear.
    await expect(page.locator('table-select-dialog dialog')).toHaveCount(0);

    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find(
            (x: { workspaceId: string; name: string }) =>
              x.workspaceId === ws && x.name === 'sales/orders',
          );
          if (!t) return null;
          const rows = await store.rows(t.id).find();
          return rows.length;
        }, workspaceId),
      )
      .toBe(2);
  });
});
