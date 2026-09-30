import { test, expect, type Page } from './fixtures.js';

/**
 * Picking a workspace from the header list opens the FILE that row stands for.
 *
 * The list holds **one row per workspace id** — the id IS the file name, so two
 * rows reading the same thing were two spellings of one destination. It used to
 * show both copies of a workspace the folder and this browser each held, on the
 * grounds that declining the conflict prompt means "keep both"; the id is the
 * identity now and boot settles which copy to open, so the second row only made
 * the list unreadable.
 *
 * What still has to survive the click is the FILE. `openWorkspace(entry.name)`
 * reduced a row to a name and boot turned the name back into a file
 * (`spaceFileName`), so a row standing for `demo.edb` opened `simon.edb`.
 *
 * A granted folder cannot be had in a test (`showDirectoryPicker` is a native
 * dialog Playwright cannot drive), so the scan RESULT is seeded, which is what
 * every reader downstream of the picker consumes. Without the grant the adopt
 * cannot complete — and that is what makes the assertion sharp: the failure
 * message names the file that was asked for, so it says which row was understood.
 */

const INDEX_KEY = 'eda:folderIndex';
const FILES_KEY = 'eda:folderFiles';

/** What `workspace-selector` joins an option's id and file with. */
const SEP = '\u0000';

/** Two workspaces, each in its own file, plus a second copy of one of them. */
function seedFolder(page: Page) {
  return page.addInitScript(
    ([indexKey, filesKey]) => {
      localStorage.removeItem(filesKey);
      localStorage.setItem(
        indexKey,
        JSON.stringify({
          folder: 'e2e-workspaces',
          at: Date.now() - 60_000,
          files: ['simon.edb', 'demo.edb', 'powerplants.edb'],
          workspaces: [
            // Listed BEFORE the canonically named file on purpose: the row must
            // stand for `simon.edb` whatever order the scan reported.
            { id: 'simon', title: 'Simon', file: 'powerplants.edb', tables: 7, views: 2 },
            { id: 'simon', title: 'Simon', file: 'simon.edb', tables: 3, views: 1 },
            { id: 'demo', title: 'Demo', file: 'demo.edb', tables: 1, views: 0 },
          ],
        }),
      );
    },
    [INDEX_KEY, FILES_KEY] as const,
  );
}

async function boot(page: Page, workspaceId: string) {
  await seedFolder(page);
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

const selector = (page: Page) => page.locator('app-shell workspace-selector select');

const optionValues = (page: Page) => selector(page).evaluate((el) => [...(el as HTMLSelectElement).options].map((o) => o.value));

/** Pick the row that stands for `file`. The value is the pair this spec is about. */
async function pickFile(page: Page, file: string) {
  const values = await optionValues(page);
  const index = values.findIndex((v) => v.endsWith(SEP + file));
  expect(index, `no option for ${file}`).toBeGreaterThan(-1);
  await selector(page).selectOption({ index });
}

test('one row per workspace, and the row is the file named after it', async ({ page, workspaceId }) => {
  await boot(page, workspaceId);

  const simon = selector(page)
    .locator('option')
    .filter({ hasText: /^Simon$/ });
  await expect(simon).toHaveCount(1);

  const values = await optionValues(page);
  // The canonical file wins, though the scan reported the other one first.
  expect(values.filter((v) => v.endsWith(SEP + 'simon.edb'))).toHaveLength(1);
  expect(values.filter((v) => v.endsWith(SEP + 'powerplants.edb'))).toHaveLength(0);
  // The open database's own workspace carries no file, which is what makes it the
  // one row that does NOT go looking in the folder.
  expect(values.filter((v) => v.endsWith(SEP))).toHaveLength(1);
});

test('picking the demo row asks for demo.edb, not the workspace’s own name', async ({ page, workspaceId }) => {
  await boot(page, workspaceId);
  await pickFile(page, 'demo.edb');

  const toast = page.locator('app-shell toast-host');
  await expect(toast).toContainText('demo.edb');
  await expect(toast).not.toContainText('simon.edb');
});

test('picking the simon row asks for simon.edb', async ({ page, workspaceId }) => {
  await boot(page, workspaceId);
  await pickFile(page, 'simon.edb');

  const toast = page.locator('app-shell toast-host');
  await expect(toast).toContainText('simon.edb');
  await expect(toast).not.toContainText('demo.edb');
});
