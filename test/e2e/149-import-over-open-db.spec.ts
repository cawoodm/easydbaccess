import { expect, test, type Page } from './fixtures.js';
import { createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * An Open that lands on the workspace you are already in must leave the app
 * working until the reload arrives.
 *
 * `importBytes` has to close the open database before it writes over it — an
 * open connection holds cached pages and a journal for the file it was given, so
 * leaving it open means SQLite writing those back over the bytes just imported,
 * and the reload comes up on the OLD database. That much is not optional.
 *
 * Leaving it CLOSED was. The caller's reload is a round trip away, and in
 * between every call threw `store used before the database was opened`: the app
 * stayed on screen answering nothing — no grid, no palette — with nothing to say
 * why. `123-folder-file-refresh` "a switch back into the workspace reads the
 * file" lost about one run in five to it, and `137-reload-not-dirty` failed only
 * after its neighbours had left a file for it to land on.
 *
 * The import now re-opens what it placed, which is what the reload does anyway.
 */

/** Ask the live store something ordinary, and say what came back. */
async function storeStillAnswers(page: Page): Promise<string> {
  return page.evaluate(async () => {
    try {
      const ctx = (window as unknown as { __easydb: { store: { workspaces: { find(): Promise<unknown[]> } } } }).__easydb;
      const spaces = await ctx.store.workspaces.find();
      return `ok:${spaces.length}`;
    } catch (err) {
      return `threw:${err instanceof Error ? err.message : String(err)}`;
    }
  });
}

/**
 * Import a copy of THIS tab's own database over itself, the way Open does.
 *
 * The bytes are this workspace's, so the test is about the state the import
 * leaves behind rather than about what it contains.
 */
async function importOverSelf(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const { edbBridge } = await import('/src/db/edb/active-bridge.ts');
    const { activeEdbName } = await import('/src/db/edb/session.ts');
    const bridge = edbBridge();
    if (!bridge) throw new Error('no live bridge');
    const bytes = await bridge.export();
    await bridge.importBytes(activeEdbName(), bytes);
  });
}

test('the app keeps answering between an import over its own database and the reload', async ({ page }) => {
  const id = await createTable(page, 'Things', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await importOverSelf(page);

  // No reload in between: this is exactly the window the user is in after an
  // Open, and it used to be a dead app.
  expect(await storeStillAnswers(page)).toMatch(/^ok:/);
});

test('the grid still paints after an import over its own database', async ({ page }) => {
  // The store answering is the mechanism; a table still on screen is what the
  // user would notice. A repaint is asked for on purpose, so this cannot pass on
  // pixels painted before the import.
  const id = await createTable(page, 'Things', [{ field: 'name' }]);
  await waitForPanel(page, id);

  await importOverSelf(page);

  const grid = page.locator(`#${panelDomId(id)} data-table`).first();
  await grid.evaluate((el: Element) => (el as unknown as { loadRows(): Promise<void> }).loadRows());
  await expect(grid).toBeVisible();
  expect(await storeStillAnswers(page)).toMatch(/^ok:/);
});
