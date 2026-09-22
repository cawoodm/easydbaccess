import { test, expect, type Page } from './fixtures.js';
import { addRow, bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * A preview window has a header: what it is showing, which record where that is
 * not obvious, an Edit button for the value and an Edit record button for the
 * row it came from.
 *
 * The window was a dead end before. It exists because the value is too long for
 * its cell — so it is exactly where a typo gets noticed, and the reader had to
 * close it, find the cell again and click its text. Worse from a `preview/…`
 * commandlet, where the row may not be on screen at all.
 *
 * The editor it opens is the source editor, not a renderer: the STORED value in a
 * textarea. A grid cell renderer mounted in this window would be an editor over
 * the COMPUTED value, which on a scripted column would overwrite the very
 * Markdown the script reads.
 */

const popup = (page: Page) => page.locator('[id^="easydb-preview-popup-"]').last();
const editor = (page: Page) => page.locator('[id^="easydb-html-edit-"]').last();
const cellOf = (page: Page, id: string) => page.locator(`#${panelDomId(id)}`).locator('data-table tbody td markdown-cell');

async function mdTable(page: Page, name: string, note: string, extra: Record<string, unknown> = {}) {
  const id = await createTable(page, name, [{ field: 'note', label: 'Note', renderer: 'markdown', ...extra }]);
  await waitForPanel(page, id);
  await addRow(page, id, { note });
  return id;
}

test.describe('a cell preview', () => {
  test('names the column and offers Edit', async ({ page }) => {
    const id = await mdTable(page, 'hdr', '# Title\n\nSome text.');
    await cellOf(page, id).locator('button').click();

    const header = popup(page).locator('.eda-preview-header');
    await expect(header).toContainText('Note');
    await expect(header.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    // The value is still what the window is for.
    await expect(popup(page).locator('h1')).toHaveText('Title');
  });

  test('Edit opens the source, and a save shows in the window and in the cell', async ({ page }) => {
    const id = await mdTable(page, 'hdredit', '# Title\n\nSome text.');
    await cellOf(page, id).locator('button').click();
    await popup(page).getByRole('button', { name: 'Edit', exact: true }).click();

    // The Markdown source, not the rendered HTML.
    const ta = editor(page).locator('textarea');
    await expect(ta).toHaveValue('# Title\n\nSome text.');
    await ta.fill('# Fixed\n\nBetter text.');
    await editor(page).getByRole('button', { name: 'Save' }).click();

    // Repainted where the reader is looking…
    await expect(popup(page).locator('h1')).toHaveText('Fixed');
    // …and written through to the row, like any other cell edit.
    await expect(cellOf(page, id)).toContainText('Better text.');
    await expect.poll(async () => (await readRows(page, id))[0]?.data.note).toBe('# Fixed\n\nBetter text.');
  });

  test('a long value scrolls under the header, which stays where it is', async ({ page }) => {
    // The value box was the whole window content before, sized `height:100%`. As a
    // flex child with a sibling that overflows the parent instead of sharing it,
    // so the header has to be the thing that does not scroll.
    const long = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`).join('\n\n');
    const id = await mdTable(page, 'hdrscroll', long);
    await cellOf(page, id).locator('button').click();

    const header = popup(page).locator('.eda-preview-header');
    const before = await header.boundingBox();
    const body = popup(page).locator('.eda-preview-header + div');
    const metrics = await body.evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(metrics.scroll).toBeGreaterThan(metrics.client);

    await body.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    expect(await header.boundingBox()).toEqual(before);
  });

  test('Edit record opens the whole row in the record form', async ({ page }) => {
    // The window shows ONE cell. The answer to "is this the wrong value?" is
    // usually in the fields beside it, and this is the way to them.
    const id = await createTable(page, 'hdrrec', [{ field: 'name' }, { field: 'note', label: 'Note', renderer: 'markdown' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Ada', note: '# Title' });

    await cellOf(page, id).locator('button').click();
    await popup(page).getByRole('button', { name: 'Edit record' }).click();

    const record = page.locator('new-record-dialog dialog');
    await expect(record).toBeVisible();
    await expect(record).toContainText('Edit record');
    // The row this cell belongs to — including the field the popup never showed.
    await expect(record.locator('label.field', { hasText: 'name' }).locator('input')).toHaveValue('Ada');

    await record.locator('label.field', { hasText: 'name' }).locator('input').fill('Grace');
    await record.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => (await readRows(page, id))[0]?.data.name).toBe('Grace');
  });

  test('a read-only column offers View source instead, with nothing to save', async ({ page }) => {
    const id = await mdTable(page, 'hdrro', '# Fixed value', { readonly: true });
    await cellOf(page, id).locator('button').click();

    await expect(popup(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await popup(page).getByRole('button', { name: 'View source' }).click();
    await expect(editor(page).locator('textarea')).toHaveValue('# Fixed value');
    await expect(editor(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
  });
});

test.describe('a preview/… commandlet window', () => {
  const COLUMNS = [
    { field: 'id', label: 'Id' },
    { field: 'body', label: 'Body', renderer: 'markdown' },
  ];
  const ROWS = [
    { id: 'n-1', body: '# Berlin\n\nA city.' },
    { id: 'n-2', body: '# Bern\n\nThe Swiss capital.' },
  ];

  const seed = async (page: Page, columns = COLUMNS) => {
    const id = await createTable(page, 'notes', columns);
    await bulkAddRows(page, id, ROWS);
    await waitForPanel(page, id);
    return id;
  };

  const runHash = (page: Page, cmdlet: string) =>
    page.evaluate((h) => {
      location.hash = h;
    }, cmdlet);

  test('names the record it found, which may not be on screen', async ({ page }) => {
    await seed(page);
    await runHash(page, 'preview/notes/n-2');

    const header = popup(page).locator('.eda-preview-header');
    await expect(header).toContainText('Body');
    // The key column's value — the answer to "which record is this?".
    await expect(header).toContainText('n-2');
  });

  test('Edit writes the row, and the window shows what was written', async ({ page }) => {
    const id = await seed(page);
    await runHash(page, 'preview/notes/n-2');
    await popup(page).getByRole('button', { name: 'Edit', exact: true }).click();

    const ta = editor(page).locator('textarea');
    await expect(ta).toHaveValue('# Bern\n\nThe Swiss capital.');
    await ta.fill('# Bern\n\nCapital of Switzerland.');
    await editor(page).getByRole('button', { name: 'Save' }).click();

    await expect(popup(page)).toContainText('Capital of Switzerland');
    // The right row, and only that row.
    await expect.poll(async () => (await readRows(page, id)).find((r) => r.data.id === 'n-2')?.data.body).toBe('# Bern\n\nCapital of Switzerland.');
    expect((await readRows(page, id)).find((r) => r.data.id === 'n-1')?.data.body).toBe('# Berlin\n\nA city.');
  });

  test('a rule the value breaks is refused, and nothing is written', async ({ page }) => {
    const id = await seed(page, [
      { field: 'id', label: 'Id' },
      { field: 'body', label: 'Body', renderer: 'markdown', notnull: true },
    ]);
    await runHash(page, 'preview/notes/n-2');
    await popup(page).getByRole('button', { name: 'Edit', exact: true }).click();

    await editor(page).locator('textarea').fill('   ');
    await editor(page).getByRole('button', { name: 'Save' }).click();

    // The grid's own rule, and the grid's own wording.
    await expect(page.locator('host-dialogs')).toContainText('cannot be empty');
    expect((await readRows(page, id)).find((r) => r.data.id === 'n-2')?.data.body).toBe('# Bern\n\nThe Swiss capital.');
  });

  test('Edit record opens the row the commandlet found, not the one on screen', async ({ page }) => {
    const id = await seed(page);
    await runHash(page, 'preview/notes/n-2');
    await popup(page).getByRole('button', { name: 'Edit record' }).click();

    const record = page.locator('new-record-dialog dialog');
    await expect(record.locator('label.field', { hasText: 'Id' }).locator('input')).toHaveValue('n-2');

    await record.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect((await readRows(page, id)).find((r) => r.data.id === 'n-2')?.data.body).toBe('# Bern\n\nThe Swiss capital.');
  });

  test('a read-only TABLE offers the record to read, not to edit', async ({ page }) => {
    const id = await seed(page);
    await page.evaluate(async (t) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).__easydb.store.tables.patch(t, { readonly: true });
    }, id);
    await runHash(page, 'preview/notes/n-2');

    await expect(popup(page).getByRole('button', { name: 'Edit record' })).toHaveCount(0);
    await popup(page).getByRole('button', { name: 'View record' }).click();

    const record = page.locator('new-record-dialog dialog');
    await expect(record).toContainText('This table is read-only');
    await expect(record.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  });

  test('a read-only column is read-only here too', async ({ page }) => {
    await seed(page, [
      { field: 'id', label: 'Id' },
      { field: 'body', label: 'Body', renderer: 'markdown', readonly: true },
    ]);
    await runHash(page, 'preview/notes/n-2');

    await expect(popup(page).getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect(popup(page).getByRole('button', { name: 'View source' })).toBeVisible();
  });
});
