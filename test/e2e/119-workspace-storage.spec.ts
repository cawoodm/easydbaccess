import { expect, test, type Page } from '@playwright/test';
import { addRow, bindWorkspaceToFile, bindWorkspaceToFileOnce, createTable, waitForEdbMirror, EDB_REGISTRY_KEY } from './helpers.js';

/**
 * **Storage is a property of the workspace, not of the browser.**
 *
 * One workspace kept in a `.edb` used to hide every other workspace. A single
 * `localStorage` key named "the open file", and `localStorage` is per ORIGIN —
 * exactly like IndexedDB — so that one name governed every workspace and every
 * tab. The selector then listed only what the file held: the IndexedDB
 * workspaces were still there, but nothing in the app named them.
 *
 * These tests keep two workspaces in two different stores at the same time, which
 * is the state the old key could not represent.
 *
 * The OS file picker cannot be driven from Playwright, so the registry entry is
 * written directly — see `bindWorkspaceToFile`. Everything downstream of it is
 * the real thing: worker, store, OPFS mirror, reload.
 */

/** Boot into `space`, whichever store the registry says it belongs to. */
async function boot(page: Page, space: string): Promise<void> {
  await page.goto(`/?test=1&space=${encodeURIComponent(space)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

/** Every name in the header's workspace list, marker and all. */
async function listed(page: Page): Promise<string[]> {
  const options = page.locator('workspace-selector select option');
  await expect(options.first()).toBeAttached();
  return (await options.allTextContents()).map((t) => t.trim());
}

/** The tables the open workspace can see. */
function tableNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { workspaceId: string; store: { tables: { find(): Promise<Array<{ name: string; workspaceId: string }>> } } } }).__easydb;
    return (await ctx.store.tables.find()).filter((t) => t.workspaceId === ctx.workspaceId).map((t) => t.name);
  });
}

/**
 * The workspace ids the ACTIVE store holds.
 *
 * This is the probe that says which store won, and it says it without asking the
 * app: a `.edb` holds only its own workspaces, and IndexedDB holds only the ones
 * that were never moved into a file. Counting IndexedDB databases would not do —
 * the database goes on existing on the origin once any workspace has used it.
 */
function storeHolds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const ctx = (window as unknown as { __easydb: { store: { workspaces: { find(): Promise<Array<{ id: string }>> } } } }).__easydb;
    return (await ctx.store.workspaces.find()).map((w) => w.id);
  });
}

/** What the registry holds, as workspace id → file. */
function registry(page: Page): Promise<Record<string, { name: string; file: string }>> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, { name: string; file: string }>, EDB_REGISTRY_KEY);
}

test('a workspace kept in a file does not hide the ones in browser storage', async ({ page }, testInfo) => {
  const local = `local-${testInfo.testId}`;
  const filed = `filed-${testInfo.testId}`;

  // One workspace in IndexedDB, with something in it to find again.
  await boot(page, local);
  const localTable = await createTable(page, 'Local', [{ field: 'note' }]);
  await addRow(page, localTable, { note: 'in the browser' });

  // The other in a file, which is what the File menu's New .edb does.
  await bindWorkspaceToFile(page, filed, `${filed}.edb`, filed);
  await boot(page, filed);
  await createTable(page, 'InFile', [{ field: 'note' }]);
  // Boot restores a file-backed workspace from the OPFS mirror, and the mirror is
  // debounced. Leaving before it lands comes back to an empty database.
  await waitForEdbMirror(page, `${filed}.edb`);

  // The file store cannot see the IndexedDB workspace, and vice versa — which is
  // exactly why the list cannot come from the store alone.
  expect(await storeHolds(page)).toEqual([filed]);
  expect(await tableNames(page)).toEqual(['InFile']);

  // Both are listed, and the file-backed one is marked.
  const names = await listed(page);
  expect(names).toContain(local);
  expect(names.some((n) => n.includes(filed) && n !== filed)).toBe(true);

  // And the browser workspace still opens, with its own data.
  await boot(page, local);
  expect(await tableNames(page)).toEqual(['Local']);
  expect(await storeHolds(page)).toEqual([local]);
  // Seen from IndexedDB, the file-backed workspace is still in the list. This is
  // the direction that was broken the other way round.
  expect((await listed(page)).some((n) => n.includes(filed))).toBe(true);
});

test('a second workspace in a second file leaves the first one alone', async ({ page }, testInfo) => {
  const one = `one-${testInfo.testId}`;
  const two = `two-${testInfo.testId}`;
  await bindWorkspaceToFile(page, one, `${one}.edb`, one);
  await bindWorkspaceToFile(page, two, `${two}.edb`, two);

  await boot(page, one);
  await createTable(page, 'First', [{ field: 'a' }]);
  await waitForEdbMirror(page, `${one}.edb`);
  await boot(page, two);
  await createTable(page, 'Second', [{ field: 'a' }]);
  await waitForEdbMirror(page, `${two}.edb`);

  // Two files, two workspaces, no bleed. One global "active file" could not tell
  // these apart.
  expect(await tableNames(page)).toEqual(['Second']);
  await boot(page, one);
  expect(await tableNames(page)).toEqual(['First']);
});

test('a new browser workspace made from a file-backed one is not created inside the file', async ({ page }, testInfo) => {
  const filed = `src-${testInfo.testId}`;
  await bindWorkspaceToFile(page, filed, `${filed}.edb`, filed);
  await boot(page, filed);
  await createTable(page, 'InFile', [{ field: 'note' }]);
  await waitForEdbMirror(page, `${filed}.edb`);

  const dialogs = page.locator('host-dialogs');
  await page.evaluate(async () => {
    const { newWorkspaceFlow } = await import('/src/chrome/workspace-actions.ts');
    void newWorkspaceFlow();
  });
  await dialogs.getByRole('textbox').fill('plain');
  await dialogs.getByRole('button', { name: 'OK', exact: true }).click();
  // Simple means IndexedDB. The inherit question is skipped here: there is nothing
  // to clone, because the workspace on screen is in a file that Dexie cannot read.
  await dialogs.getByRole('button', { name: /^Simple/ }).click();
  await page.waitForURL(/space=plain/, { timeout: 20_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  // It went to IndexedDB, and boot did NOT make an empty workspace inside the
  // file to land in — which is what happened while the file was chosen globally.
  expect(await storeHolds(page)).toEqual(['plain']);
  expect(await tableNames(page)).toEqual([]);
  // Both are on the roster, each pointing at its own store. `plain` has no file.
  const known = await registry(page);
  expect(Object.keys(known).sort()).toEqual([filed, 'plain'].sort());
  expect(known['plain']?.file).toBeUndefined();
  expect(known[filed]?.file).toBe(`${filed}.edb`);

  // The file workspace is untouched and still reachable.
  await boot(page, filed);
  expect(await tableNames(page)).toEqual(['InFile']);
});

test('deleting a file-backed workspace empties the file and drops it from the list', async ({ page }, testInfo) => {
  const keeper = `keep-${testInfo.testId}`;
  const goner = `gone-${testInfo.testId}`;

  await boot(page, keeper);
  await createTable(page, 'Keeper', [{ field: 'a' }]);

  // Written once, not as an init script: this test proves the entry is DROPPED,
  // and an init script would put it back on the reload the delete triggers.
  await bindWorkspaceToFileOnce(page, goner, `${goner}.edb`, goner);
  await boot(page, goner);
  const doomed = await createTable(page, 'Doomed', [{ field: 'a' }]);
  await addRow(page, doomed, { a: 'x' });
  await waitForEdbMirror(page, `${goner}.edb`);

  const dialogs = page.locator('host-dialogs');
  await page.evaluate(async () => {
    const { deleteWorkspaceFlow } = await import('/src/chrome/workspace-actions.ts');
    void deleteWorkspaceFlow();
  });
  // The dialog counts what is in the FILE. Pointed at Dexie it said "0 tables"
  // and then deleted nothing at all.
  await expect(dialogs.getByText(/1 table/)).toBeVisible();
  await expect(dialogs.getByText(new RegExp(`The file "${goner}\\.edb" is left on disk`))).toBeVisible();
  await dialogs.getByRole('button', { name: 'Yes', exact: true }).click();

  await page.waitForURL(new RegExp(`space=${keeper}`), { timeout: 20_000 });
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });

  // Gone from the registry, so gone from the list — and it does not come back on
  // the next load, which is what a delete against the wrong store looked like.
  expect(Object.keys(await registry(page))).toEqual([keeper]);
  expect((await listed(page)).some((n) => n.includes(goner))).toBe(false);
  expect(await tableNames(page)).toEqual(['Keeper']);
});
