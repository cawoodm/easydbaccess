import { expect, test, type Page } from '@playwright/test';
import { addRow, createTable, readRows, waitForPanel } from './helpers.js';

/**
 * Settling a workspace against the copy of it in a `.edb`, table by table and
 * record by record.
 *
 * Until now the file layer could only ask "which whole copy do you want", and
 * both answers threw away somebody's work whenever BOTH had been edited — which
 * is exactly what a folder shared between two machines produces. These specs
 * drive the four answers that replace it: Take newest, Compare tables, Push,
 * Pull.
 *
 * ## How "another machine" is faked
 *
 * The page cannot build a `.edb` by hand, so the second copy is made by the app
 * itself and then put BACK:
 *
 *   1. save — the file now holds state A
 *   2. keep a copy of those bytes
 *   3. change the workspace, save again — the file now holds state B
 *   4. write the kept bytes over the file — the file holds A, this tab holds B
 *
 * After step 4 the two copies genuinely differ and the recorded stamp no longer
 * matches the file, which is precisely the state another machine leaves behind.
 */

const FOLDER = 'merge-folder';

async function boot(page: Page, workspaceId: string): Promise<void> {
  await page.addInitScript(
    ({ folder }) => {
      delete (window as unknown as Record<string, unknown>)['showSaveFilePicker'];
      (window as unknown as Record<string, unknown>)['showDirectoryPicker'] = async () => {
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(folder, { create: true });
      };
    },
    { folder: FOLDER },
  );
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

const saveButton = (page: Page) => page.locator('app-shell').getByRole('button', { name: /Save/ });
const dialog = (page: Page) => page.locator('host-dialogs');
// The inner `<dialog>`, not the host element: the host has no box of its own, so
// Playwright reads it as hidden however open the dialog is.
const merger = (page: Page) => page.locator('merge-dialog dialog');
const toast = (page: Page) => page.locator('toast-host');

/** The whole file, as a plain array so it survives the round trip through the page. */
async function snapshotFile(page: Page, name: string): Promise<number[]> {
  return page.evaluate(
    async ({ folder, file }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const bytes = new Uint8Array(await (await (await dir.getFileHandle(file)).getFile()).arrayBuffer());
      return [...bytes];
    },
    { folder: FOLDER, file: name },
  );
}

/** Put an earlier copy of the file back — "the other machine's version". */
async function restoreFile(page: Page, name: string, bytes: number[]): Promise<void> {
  await page.evaluate(
    async ({ folder, file, bytes }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const w = await (await dir.getFileHandle(file)).createWritable();
      await w.write(new Uint8Array(bytes));
      await w.close();
    },
    { folder: FOLDER, file: name, bytes },
  );
}

/** The first save, which is also what connects the folder. */
async function saveIntoFolder(page: Page, space: string): Promise<void> {
  await saveButton(page).click();
  await expect(dialog(page).getByText(/stored in this browser/)).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Connect a folder…', exact: true }).click();
  await expect(toast(page)).toContainText(`${space}.edb`, { timeout: 30_000 });
}

/**
 * Every later save, once the folder is connected.
 *
 * Waited on by watching the FILE, not the toast. A toast renders into a shadow
 * root, so it cannot be cleared from the outside and the assertion matches the
 * PREVIOUS save's message instantly — which made every step after this one read
 * a file the save had not written yet.
 */
async function saveAgain(page: Page, space: string): Promise<void> {
  const before = await fileFacts(page, `${space}.edb`);
  await saveButton(page).click();
  await expect.poll(() => fileFacts(page, `${space}.edb`), { timeout: 30_000 }).not.toEqual(before);
}

/** Size and last-modified of a file in the stub folder. */
async function fileFacts(page: Page, name: string): Promise<{ size: number; mtime: number }> {
  return page.evaluate(
    async ({ folder, file }) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(folder);
      const f = await (await dir.getFileHandle(file)).getFile();
      return { size: f.size, mtime: f.lastModified };
    },
    { folder: FOLDER, file: name },
  );
}

/** Run a palette command by its title. */
async function runCommand(page: Page, title: string): Promise<void> {
  await page
    .locator('app-shell header')
    .getByTitle(/open the command palette/i)
    .click();
  const palette = page.locator('command-palette-dialog dialog');
  await palette.locator('input').fill(title);
  await palette.locator('.item', { hasText: title }).first().click();
}

async function tableNames(page: Page): Promise<string[]> {
  const tables = (await page.evaluate(async () => (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ name: string }[]> } } } }).__easydb.store.tables.find())) as { name: string }[];
  return tables.map((t) => t.name).sort();
}

async function tableIdNamed(page: Page, name: string): Promise<string> {
  const id = await page.evaluate(
    async (wanted) => {
      const store = (window as unknown as { __easydb: { store: { tables: { find(): Promise<{ id: string; name: string }[]> } } } }).__easydb.store;
      return (await store.tables.find()).find((t) => t.name === wanted)?.id ?? '';
    },
    name,
  );
  return id;
}

/**
 * A workspace whose file holds a table this tab has since deleted.
 *
 * The classic pull: another machine still has Beta, this one does not.
 */
async function fileAheadByATable(page: Page, space: string): Promise<void> {
  await boot(page, space);
  const alpha = await createTable(page, 'Alpha', [{ field: 'part' }]);
  await waitForPanel(page, alpha);
  await saveIntoFolder(page, space);

  const beta = await createTable(page, 'Beta', [{ field: 'note' }]);
  await addRow(page, beta, { note: 'from the other machine' });
  await saveAgain(page, space);
  const withBeta = await snapshotFile(page, `${space}.edb`);

  // This tab loses Beta and saves, so the file no longer has it either...
  await page.evaluate(async (id) => (window as unknown as { __easydb: { store: { tables: { remove(id: string): Promise<void> } } } }).__easydb.store.tables.remove(id), beta);
  await saveAgain(page, space);
  // ...and then the older copy goes back on disk. Now the file has Beta and this
  // tab does not, which is what a second machine still holding it looks like.
  await restoreFile(page, `${space}.edb`, withBeta);
}

test('the clash offers four answers, not two', async ({ page }) => {
  await fileAheadByATable(page, 'four');

  await saveButton(page).click();

  await expect(dialog(page).getByText(/has been written since this tab last saved it/)).toBeVisible({ timeout: 20_000 });
  await expect(dialog(page).getByRole('button', { name: 'Take newest', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Compare tables…', exact: true })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /^Push/ })).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: /^Pull/ })).toBeVisible();
});

test('Take newest brings in a table only the file has', async ({ page }) => {
  await fileAheadByATable(page, 'newest');
  expect(await tableNames(page)).toEqual(['Alpha']);

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Take newest', exact: true }).click();

  // Newest never deletes: a table only one side has is carried across, not
  // dropped for having no rival.
  await expect.poll(() => tableNames(page), { timeout: 30_000 }).toEqual(['Alpha', 'Beta']);
  const beta = await tableIdNamed(page, 'Beta');
  expect(await readRows(page, beta)).toHaveLength(1);
});

test('Compare tables lists what differs and does nothing until Merge', async ({ page }) => {
  await fileAheadByATable(page, 'compare');

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Compare tables…', exact: true }).click();

  await expect(merger(page)).toBeVisible({ timeout: 20_000 });
  await expect(merger(page).getByTestId('merge-summary')).toContainText('1 table only in the file');
  await expect(merger(page).getByTestId('merge-table-Beta')).toContainText('only in the file');
  // Alpha matches, so it is listed as in step and has no answer to give.
  await expect(merger(page).getByTestId('merge-table-Alpha')).toContainText('in step');
  // Still untouched while the dialog is open.
  expect(await tableNames(page)).toEqual(['Alpha']);

  await merger(page).getByTestId('merge-apply').click();
  await expect.poll(() => tableNames(page), { timeout: 30_000 }).toEqual(['Alpha', 'Beta']);
});

test('cancelling the comparison changes neither copy', async ({ page }) => {
  await fileAheadByATable(page, 'cancelled');
  const before = await snapshotFile(page, 'cancelled.edb');

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Compare tables…', exact: true }).click();
  await expect(merger(page)).toBeVisible({ timeout: 20_000 });
  await merger(page).getByRole('button', { name: 'Cancel', exact: true }).click();

  expect(await tableNames(page)).toEqual(['Alpha']);
  expect(await snapshotFile(page, 'cancelled.edb')).toEqual(before);
});

test('Skip leaves a difference exactly as it was', async ({ page }) => {
  await fileAheadByATable(page, 'skipped');

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Compare tables…', exact: true }).click();
  await expect(merger(page)).toBeVisible({ timeout: 20_000 });
  await merger(page).getByTestId('merge-choice-Beta').selectOption('skip');
  await merger(page).getByTestId('merge-apply').click();

  // The answer that touches nothing has to actually touch nothing — otherwise
  // "Skip" is just a slower Push.
  await expect(toast(page)).toContainText('Nothing changed on either side', { timeout: 30_000 });
  expect(await tableNames(page)).toEqual(['Alpha']);
});

test('Push writes this copy out and leaves the file with no Beta', async ({ page }) => {
  await fileAheadByATable(page, 'pushed');

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Compare tables…', exact: true }).click();
  await expect(merger(page)).toBeVisible({ timeout: 20_000 });
  // An explicit Push on a table only the FILE has means "make the file match
  // here", and here does not have it. This is the one way to ask for a delete.
  await merger(page).getByTestId('merge-choice-Beta').selectOption('here');
  await merger(page).getByTestId('merge-apply').click();

  await expect(toast(page)).toContainText('Merged', { timeout: 30_000 });
  expect(await tableNames(page)).toEqual(['Alpha']);
});

/**
 * The record level: both copies have the table, and one row lives in only one of
 * them.
 */
async function fileAheadByARow(page: Page, space: string): Promise<string> {
  await boot(page, space);
  const alpha = await createTable(page, 'Alpha', [{ field: 'part' }]);
  await waitForPanel(page, alpha);
  await addRow(page, alpha, { part: 'kept' });
  await saveIntoFolder(page, space);

  const extra = await addRow(page, alpha, { part: 'only in the file' });
  await saveAgain(page, space);
  const withExtra = await snapshotFile(page, `${space}.edb`);

  await page.evaluate(
    async ({ table, row }) => (window as unknown as { __easydb: { store: { rows(t: string): { remove(id: string): Promise<void> } } } }).__easydb.store.rows(table).remove(row),
    { table: alpha, row: extra },
  );
  await saveAgain(page, space);
  await restoreFile(page, `${space}.edb`, withExtra);
  return alpha;
}

test('Compare records shows the row only the file has, and Merge brings it back', async ({ page }) => {
  const alpha = await fileAheadByARow(page, 'records');
  expect(await readRows(page, alpha)).toHaveLength(1);

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Compare tables…', exact: true }).click();
  await expect(merger(page)).toBeVisible({ timeout: 20_000 });
  await expect(merger(page).getByTestId('merge-table-Alpha')).toContainText('differs');

  await merger(page).getByTestId('merge-records-Alpha').click();
  // The row is named by its first column, not by its id — a UUID tells the
  // reader nothing about which record they are deciding on.
  await expect(merger(page).getByText('only in the file', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
  await expect(merger(page)).toContainText('1 of 1 shown');

  await merger(page).getByTestId('merge-apply').click();
  await expect.poll(async () => (await readRows(page, alpha)).length, { timeout: 30_000 }).toBe(2);
});

test('a record answered Push is dropped from the file instead of pulled in', async ({ page }) => {
  const alpha = await fileAheadByARow(page, 'droprow');

  await saveButton(page).click();
  await dialog(page).getByRole('button', { name: 'Compare tables…', exact: true }).click();
  await expect(merger(page)).toBeVisible({ timeout: 20_000 });
  await merger(page).getByTestId('merge-records-Alpha').click();
  await expect(merger(page)).toContainText('1 of 1 shown', { timeout: 20_000 });

  await merger(page).getByTestId('merge-rows-all-here').click();
  await merger(page).getByTestId('merge-apply').click();

  await expect(toast(page)).toContainText('Merged', { timeout: 30_000 });
  // This side asked to win, so the row it does not have goes from the file too.
  expect(await readRows(page, alpha)).toHaveLength(1);
});

test('a file that matches says so instead of opening an empty comparison', async ({ page }) => {
  await boot(page, 'instep');
  const alpha = await createTable(page, 'Alpha', [{ field: 'part' }]);
  await waitForPanel(page, alpha);
  await saveIntoFolder(page, 'instep');

  // Reached by the command rather than by a clash: there is no clash to provoke
  // when the two copies agree, and that is the case worth a sentence.
  await runCommand(page, 'Compare workspace with its file');

  await expect(toast(page)).toContainText('Every table matches', { timeout: 30_000 });
});
