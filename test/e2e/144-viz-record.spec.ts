import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * The `record` visualization: ONE row of the grid beside it.
 *
 * Four things here cannot be checked from the data model, and each is a
 * different piece of the feature:
 *
 *  - **tokens are COLUMN NAMES.** `$title` is the `title` column of the row on
 *    screen, with no mapping dialog and no `ViewInstance.mapping` behind it.
 *    That is bought with an identity mapping into `substituteRow`, so the proof
 *    is that a template written against field names simply works.
 *  - **the default costs nobody anything.** With no HTML at all the pane draws a
 *    card of every column. A feature that starts as an empty textarea is one
 *    nobody switches on.
 *  - **double-click selects**, and the pane follows. That is `current-row.ts`,
 *    the one new seam, and it must not disturb the grid's filter.
 *  - **`$input.field` writes**, through the grid's own rules — so a Not-null
 *    column cannot be emptied from a template.
 */

/** Row positions, named — `rowOf` takes an index. */
const BERN = 1;
const BASEL = 2;

const ROWS = [
  { title: 'Berlin', note: 'first note', done: false },
  { title: 'Bern', note: 'second note', done: true },
  { title: 'Basel', note: 'third note', done: false },
];

async function seed(page: Page) {
  const id = await createTable(page, 'Notes', [{ field: 'title' }, { field: 'note', type: 'text' }, { field: 'done', type: 'boolean' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, ROWS);
  return id;
}

/**
 * Create a Record template and dock an instance of it below the grid.
 *
 * The template name has to be one no SEEDED template contains: `views-seed.ts`
 * ships "Contact Cards", so a template called "Card" made `hasText` match two
 * rows in the list.
 */
async function dockRecord(page: Page, tableId: string, html?: string) {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: '+ New visualization' }).click();
  await dlg.locator('input[type=text]').first().fill('Recordpane');
  await dlg.locator('select').first().selectOption('record');
  const boxes = dlg.locator('.code-field textarea');
  // One `code` option: the layout. A record pane has no script box — the rows it
  // draws are one row, and a script over one row is a column script.
  await expect(boxes).toHaveCount(1);
  if (html !== undefined) await boxes.nth(0).fill(html);
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.locator('ul.list li', { hasText: 'Recordpane' }).getByRole('button', { name: 'Use' }).click();
  await dlg.locator('select').first().selectOption('below');
  await dlg.getByRole('button', { name: 'Create view' }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator('views-dialog dialog[open]')).toHaveCount(0);
}

const canvasOf = (page: Page, tableId: string) => page.locator(`#${panelDomId(tableId)} viz-record .canvas`);
const grid = (page: Page, tableId: string) => page.locator(`#${panelDomId(tableId)} data-table`);
/**
 * A data row, BY POSITION. `tr[data-row-id]` is what marks one — a header `tr`
 * has none.
 *
 * Not by its text: a cell's value can be drawn by a cell renderer inside its own
 * shadow root, and Playwright's `hasText` does not reach in there. Position is
 * exact here anyway — `ROWS` is inserted in order and nothing sorts it.
 */
const rowOf = (page: Page, tableId: string, index: number) => grid(page, tableId).locator('tr[data-row-id]').nth(index);

test.describe('record visualization', () => {
  test('a token is its own column name', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<h2 id="t">$title</h2><p id="n">$raw.note</p>');

    const canvas = canvasOf(page, id);
    // No mapping was ever asked for, and none exists on the instance.
    await expect(canvas.locator('#t')).toHaveText('Berlin');
    await expect(canvas.locator('#n')).toHaveText('first note');
  });

  test('with no layout it draws an editable card of every column', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id);

    const canvas = canvasOf(page, id);
    const rows = canvas.locator('.eda-rec-row');
    await expect(rows).toHaveCount(3);
    await expect(canvas.locator('.eda-rec-label').nth(0)).toHaveText('title');
    // Editable from the start: the card IS the form. A card you must rewrite
    // before you can correct a typo in it is a card you read once.
    await expect(canvas.locator('.eda-rec-value').nth(0).locator('input.eda-input')).toHaveValue('Berlin');
  });

  test('it starts on the first row the grid is showing', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<b id="t">$title</b>');
    // Nothing has been selected, so "the first visible row" is the answer — and
    // it means a freshly docked pane draws something immediately rather than
    // waiting to be told.
    await expect(canvasOf(page, id).locator('#t')).toHaveText('Berlin');
  });

  test('double-clicking a row selects it, without touching the filter', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<b id="t">$title</b>');

    await rowOf(page, id, BASEL).dblclick();
    await expect(canvasOf(page, id).locator('#t')).toHaveText('Basel');

    // Selecting is not filtering: all three rows are still in the grid. A
    // selection built on `pane-actions.ts` would have narrowed it to one.
    await expect(grid(page, id).locator('tr[data-row-id]')).toHaveCount(3);
  });

  test('the record form does not also open on that double-click', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<b id="t">$title</b>');

    await rowOf(page, id, BERN).dblclick();
    await expect(canvasOf(page, id).locator('#t')).toHaveText('Bern');
    // `edit-record` owns the same gesture and stands down while a pane follows
    // this grid — two dialogs for one double-click would be one too many.
    await expect(page.locator('new-record-dialog dialog[open]')).toHaveCount(0);
  });

  test('without a record pane, nothing claims the grid selection', async ({ page }) => {
    const id = await seed(page);

    // The handover, asserted at the contract rather than through the dialog.
    // `edit-record` opens the record FORM exactly when this is false, and
    // `viz-record` selects exactly when it is true — so this IS the rule, and it
    // is deterministic. Whether the form then appears is `143-edit-record`'s
    // subject, and that spec has a plugin-load race of its own (a backlog item)
    // which this one has no business inheriting.
    const wanted = await page.evaluate(async (key) => {
      const mod = (await import('/src/table/current-row.ts')) as unknown as { currentRowWanted(k: string): boolean };
      return mod.currentRowWanted(key);
    }, id);
    expect(wanted).toBe(false);
  });

  test('a docked record pane claims it', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<b id="t">$title</b>');
    await expect(canvasOf(page, id).locator('#t')).toHaveText('Berlin');

    const wanted = await page.evaluate(async (key) => {
      const mod = (await import('/src/table/current-row.ts')) as unknown as { currentRowWanted(k: string): boolean };
      return mod.currentRowWanted(key);
    }, id);
    expect(wanted).toBe(true);
  });

  test('$input writes the cell, and the grid shows it', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<div>$input.title</div>');

    const input = canvasOf(page, id).locator('input.eda-input');
    await input.fill('Zurich');
    await input.blur();

    // The STORE is the proof: the pane asked, `viz-panel` validated and wrote.
    // Read back rather than eyeballed in the grid, because a cell's text can sit
    // inside a renderer's shadow root where an assertion cannot see it.
    await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['title'])).toContain('Zurich');
  });

  test('a boolean column is a checkbox that writes', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<div>$input.done</div>');

    const box = canvasOf(page, id).locator('input.eda-input[type=checkbox]');
    await expect(box).not.toBeChecked();
    await box.check();
    // Row one had `done: false`; it is true now.
    await expect(canvasOf(page, id).locator('input.eda-input[type=checkbox]')).toBeChecked();
  });

  test('the pane follows the grid when the selected row is filtered away', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<b id="t">$title</b>');
    await rowOf(page, id, BASEL).dblclick();
    await expect(canvasOf(page, id).locator('#t')).toHaveText('Basel');

    // Filter the selected record off screen. The pane must not go on drawing a
    // row the grid is not showing — the grid's provider vetoes the stale id.
    await grid(page, id).locator('thead input').first().fill('Ber');
    await expect(canvasOf(page, id).locator('#t')).not.toHaveText('Basel');
  });
});

/**
 * The record WINDOW — one record in a panel of its own.
 *
 * This is what a double-click gives a table with no pane docked beside it, and
 * it is the common case: nobody has to create a template, dock anything or know
 * the word "visualization" to get a usable record form out of a grid.
 *
 * The panel id carries both ids, which is what makes "a window per row" true
 * rather than "a window per double-click".
 */
test.describe('record window', () => {
  /**
   * Wait until the Record plugin has offered its opener.
   *
   * Asked at the contract rather than by double-clicking and hoping. Plugin
   * `load()` runs after first paint, so a double-click dispatched before it
   * silently falls through to the record FORM — which is the same race
   * `143-edit-record` carries, and this spec has no business inheriting it.
   */
  async function ready(page: Page) {
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const m = (await import('/src/plugins/record-popup.ts')) as unknown as { recordPopupWanted(): boolean };
          return m.recordPopupWanted();
        }),
      )
      .toBe(true);
  }

  const windowOf = (page: Page, tableId: string, rowId: string) => page.locator(`#easydb-record-${tableId}-${rowId}`);
  const anyWindow = (page: Page) => page.locator('[id^="easydb-record-"]');

  async function rowIdAt(page: Page, tableId: string, index: number): Promise<string> {
    const id = await rowOf(page, tableId, index).getAttribute('data-row-id');
    return id ?? '';
  }

  test('a double-click opens the record in its own window', async ({ page }) => {
    const id = await seed(page);
    await ready(page);

    await rowOf(page, id, BERN).dblclick();
    const win = windowOf(page, id, await rowIdAt(page, id, BERN));
    await expect(win).toBeVisible();
    // A card of every column, editable, with no template anywhere in sight.
    await expect(win.locator('viz-record .eda-rec-row')).toHaveCount(3);
    await expect(win.locator('viz-record input.eda-input').first()).toHaveValue('Bern');
  });

  test('the record form does not also open', async ({ page }) => {
    const id = await seed(page);
    await ready(page);

    await rowOf(page, id, BERN).dblclick();
    await expect(anyWindow(page)).toHaveCount(1);
    // `edit-record` owns the gesture and hands it on — it must not do both.
    await expect(page.locator('new-record-dialog dialog[open]')).toHaveCount(0);
  });

  test('a second row opens a second window, the same row does not', async ({ page }) => {
    const id = await seed(page);
    await ready(page);

    await rowOf(page, id, BERN).dblclick();
    await expect(anyWindow(page)).toHaveCount(1);

    // Another record: another window, so two records can be read side by side.
    await rowOf(page, id, BASEL).dblclick();
    await expect(anyWindow(page)).toHaveCount(2);

    // The same record again: the window it already has, fronted. Otherwise a
    // fast reader buries the canvas in copies of one row.
    await rowOf(page, id, BERN).dblclick();
    await expect(anyWindow(page)).toHaveCount(2);
  });

  test('typing in the window writes the cell', async ({ page }) => {
    const id = await seed(page);
    await ready(page);

    await rowOf(page, id, BASEL).dblclick();
    const win = windowOf(page, id, await rowIdAt(page, id, BASEL));
    const input = win.locator('viz-record input.eda-input').first();
    await input.fill('Zurich');
    await input.blur();

    await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['title'])).toContain('Zurich');
  });

  test('it uses the table’s own record layout when it has one', async ({ page }) => {
    const id = await seed(page);
    // Docked, so the pane owns the double-click — the window is opened by the
    // commandlet path instead, which is the other way in and shares the layout.
    await dockRecord(page, id, '<b id="t">$title</b>');
    await ready(page);

    const rowId = await rowIdAt(page, id, BERN);
    await page.evaluate(
      async (args) => {
        const m = (await import('/src/plugins/record-popup.ts')) as unknown as { openRecordPopup(t: string, r: string): boolean };
        m.openRecordPopup(args.t, args.r);
      },
      { t: id, r: rowId },
    );

    const win = windowOf(page, id, rowId);
    await expect(win.locator('#t')).toHaveText('Bern');
    // The layout, not the generated card.
    await expect(win.locator('.eda-rec-row')).toHaveCount(0);
  });

  test('a docked pane keeps the double-click to itself', async ({ page }) => {
    const id = await seed(page);
    await dockRecord(page, id, '<b id="t">$title</b>');
    await ready(page);

    await rowOf(page, id, BASEL).dblclick();
    await expect(canvasOf(page, id).locator('#t')).toHaveText('Basel');
    // One gesture, one result: the pane updated, so no window popped up.
    await expect(anyWindow(page)).toHaveCount(0);
  });

  test('a refused write puts the stored value back in the box', async ({ page }) => {
    const id = await createTable(page, 'Places', [{ field: 'title', notnull: true }, { field: 'note' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Bern', note: 'x' }]);
    await ready(page);

    await rowOf(page, id, 0).dblclick();
    const rowId = await rowIdAt(page, id, 0);
    const input = windowOf(page, id, rowId).locator('viz-record input.eda-input').first();
    await expect(input).toHaveValue('Bern');

    await input.fill('');
    await input.blur();
    // The rule is the grid's, lifted: a Not-null column cannot be emptied from a
    // template either. It is said in a dialog, not a toast — the box still shows
    // what was typed, so a message that vanished would leave it looking saved.
    const alert = page.locator('host-dialogs');
    await expect(alert.locator('dialog')).toBeVisible();
    await alert.getByRole('button', { name: 'OK', exact: true }).click();

    // And the box goes back to the stored value. That needs a FORCED redraw:
    // nothing the pane draws from changed, so its own guard would skip it.
    await expect(input).toHaveValue('Bern');
    await expect.poll(async () => (await readRows(page, id)).map((r: { data: Record<string, unknown> }) => r.data['title'])).toEqual(['Bern']);
  });

  test('the record/ commandlet opens it — by key and by row id', async ({ page }) => {
    const id = await seed(page);
    await ready(page);
    const rowId = await rowIdAt(page, id, BASEL);

    // By KEY — the first column, the way every other verb names a record.
    await page.evaluate(() => {
      location.hash = '#record/Notes/Bern';
    });
    await expect(windowOf(page, id, await rowIdAt(page, id, BERN)).locator('viz-record')).toBeVisible();

    // By ROW ID — the one verb that takes one, which is what makes `$_.rowId`
    // and `row._.rowId` worth having. Works on a table with no unique key.
    await page.evaluate((r) => {
      location.hash = `#record/Notes/${r}`;
    }, rowId);
    await expect(windowOf(page, id, rowId).locator('viz-record')).toBeVisible();
    await expect(anyWindow(page)).toHaveCount(2);
  });

  test('a record/ link in a cell opens that record', async ({ page }) => {
    const id = await createTable(page, 'Notes', [
      { field: 'title' },
      // The sample's shape: an anchor built from the row's own id. The `html`
      // renderer, not `link` — a `#…` commandlet has no scheme, so `link`
      // would leave it as text.
      { field: 'open', renderer: 'html', script: `function render(row) { return \`<a href="\${cmdlet(['record', 'Notes', row._.rowId])}">open</a>\`; }` },
    ]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Berlin' }, { title: 'Bern' }]);
    await ready(page);

    const rowId = await rowIdAt(page, id, 1);
    await grid(page, id).locator('tr[data-row-id]').nth(1).getByRole('link', { name: 'open' }).click();
    await expect(windowOf(page, id, rowId).locator('viz-record')).toBeVisible();
    // The click must not have navigated — the hash stays clean.
    expect(new URL(page.url()).hash).toBe('');
  });

  test('record/ with no match says so, and opens nothing', async ({ page }) => {
    const id = await seed(page);
    await ready(page);

    await page.evaluate(() => {
      location.hash = '#record/Notes/nope';
    });
    await expect(page.locator('toast-host')).toContainText(/No row in "Notes" matches/);
    await expect(anyWindow(page)).toHaveCount(0);
  });

  test('$_.rowId is the record id, with no mapping', async ({ page }) => {
    const id = await seed(page);
    await ready(page);

    const rowId = await rowIdAt(page, id, BERN);
    await page.evaluate(
      async (args) => {
        const m = (await import('/src/plugins/record-popup.ts')) as unknown as { openRecordPopup(t: string, r: string): boolean };
        m.openRecordPopup(args.t, args.r);
      },
      { t: id, r: rowId },
    );
    const win = windowOf(page, id, rowId);
    await expect(win).toBeVisible();

    // The metadata token, in the app's own `view-render` module. Asserted there
    // rather than in the window's markup, because the generated card has no
    // `$_.` in it — the point is that a layout CAN.
    //
    // The row is handed in rather than read through `getContext()`: a second
    // store session in the same tab is refused by the tab lock, which is exactly
    // what `getContext()` would start from inside `page.evaluate`.
    const out = await page.evaluate(
      async (row) => {
        const vr = (await import('/src/views/view-render.ts')) as unknown as { substituteRow(h: string, r: unknown, m: Record<string, string>): string };
        return vr.substituteRow('$_.rowId|$_.tableId|[$_.nope]', row, {});
      },
      { id: rowId, tableId: id, data: {}, updatedAt: 0 },
    );
    // An unknown key renders as nothing, like an unmapped token.
    expect(out).toBe(`${rowId}|${id}|[]`);
  });
});
