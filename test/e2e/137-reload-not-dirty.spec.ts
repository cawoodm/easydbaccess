import { expect, test, type Page } from './fixtures.js';
import { createTable, waitForPanel } from './helpers.js';

/**
 * A reload must not invent unsaved work.
 *
 * Saving cleared the red dot on the header Save button, and refreshing the
 * browser brought it straight back — so the app claimed there was something to
 * save when the user had done nothing at all. Worse than cosmetic: the dot is the
 * only cue for "your work is not in the file yet", and one that cries wolf on
 * every boot is one nobody reads.
 *
 * The cause was four no-op writes. `plugins/views-seed.ts` re-recorded the
 * "this built-in template has been seeded" mark for each of the four built-ins on
 * every load, whether or not it was already recorded, and the store broadcasts
 * every write it takes. Nothing else in a plain boot writes at all.
 */

/** What the header Save button says about this workspace. */
function saveTooltip(page: Page) {
  return page.locator('app-shell').getByRole('button', { name: /Save/ });
}

async function isDirty(page: Page): Promise<boolean> {
  const title = await saveTooltip(page).getAttribute('title');
  return (title ?? '').includes('Unsaved');
}

test('a reload with no user action leaves the workspace clean', async ({ page }) => {
  // The FIRST boot of a workspace really does write: it creates the workspace and
  // seeds the four built-in templates, so the dot is earned.
  const id = await createTable(page, 'Things', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await expect.poll(() => isDirty(page), { timeout: 15_000 }).toBe(true);

  // The second boot has nothing to do. The dirty flag lives in memory, so a
  // reload starts clean and only a WRITE during boot can dirty it again — which
  // is what four no-op seed marks used to do.
  await page.reload();
  await waitForPanel(page, id);

  await expect.poll(() => isDirty(page), { timeout: 20_000 }).toBe(false);
});
