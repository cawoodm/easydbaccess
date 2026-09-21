import { test, expect, type Page } from './fixtures.js';

/**
 * Picking a workspace from the header list opens the FILE that row stands for.
 *
 * The list merges the workspaces in the open database with the ones the connected
 * folder holds in other files, and it shows two copies of one workspace on
 * purpose — declining the conflict prompt means "keep both", so both have to stay
 * reachable. Two copies share a title, a name and usually an id; the only thing
 * that tells them apart is the file, which is why the row's tooltip is the file.
 *
 * Which made it exactly the thing that had to survive the click. It did not:
 * `openWorkspace(entry.name)` reduced the row to a name, and boot turned the name
 * back into a file (`spaceFileName`) — so `simon.edb` and `powerplants.edb`, both
 * holding `simon`, were one destination and both rows opened `simon.edb`.
 *
 * A granted folder cannot be had in a test (`showDirectoryPicker` is a native
 * dialog Playwright cannot drive), so the scan RESULT is seeded, which is what
 * every reader downstream of the picker consumes. Without the grant the adopt
 * cannot complete — and that is what makes the assertion sharp: the failure
 * message names the file that was asked for, so it says which of the two rows was
 * understood. Before the fix there was no message at all, because the click
 * navigated away to `?space=Simon`.
 */

const INDEX_KEY = 'eda:folderIndex';
const FILES_KEY = 'eda:folderFiles';

/** What `workspace-selector` joins an option's id and file with. */
const SEP = '\u0000';

/** Two files in the folder, holding the same workspace under the same title. */
function seedTwins(page: Page) {
  return page.addInitScript(
    ([indexKey, filesKey]) => {
      localStorage.removeItem(filesKey);
      localStorage.setItem(
        indexKey,
        JSON.stringify({
          folder: 'e2e-workspaces',
          at: Date.now() - 60_000,
          files: ['simon.edb', 'powerplants.edb'],
          workspaces: [
            { id: 'simon', name: 'Simon', title: 'Simon', file: 'simon.edb', tables: 3, views: 1 },
            { id: 'simon', name: 'Simon', title: 'Simon', file: 'powerplants.edb', tables: 7, views: 2 },
          ],
        }),
      );
    },
    [INDEX_KEY, FILES_KEY] as const,
  );
}

async function boot(page: Page, workspaceId: string) {
  await seedTwins(page);
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
}

const selector = (page: Page) => page.locator('app-shell workspace-selector select');

const optionValues = (page: Page) => selector(page).evaluate((el) => [...(el as HTMLSelectElement).options].map((o) => o.value));

/**
 * Pick the row that stands for `file`.
 *
 * By VALUE rather than by label or position: the two rows read identically, and
 * which order they land in is not a promise the list makes. The value is the pair
 * the fix is about, so selecting by it is also the point.
 */
async function pickFile(page: Page, file: string) {
  const values = await optionValues(page);
  const index = values.findIndex((v) => v.endsWith(SEP + file));
  expect(index, `no option for ${file}`).toBeGreaterThan(-1);
  await selector(page).selectOption({ index });
}

test('both copies are listed, and only the file tells them apart', async ({ page, workspaceId }) => {
  await boot(page, workspaceId);

  const twins = selector(page).locator('option').filter({ hasText: /^Simon$/ });
  await expect(twins).toHaveCount(2);

  // Identical to read, distinct to act on.
  const values = await optionValues(page);
  expect(values.filter((v) => v.endsWith(SEP + 'simon.edb'))).toHaveLength(1);
  expect(values.filter((v) => v.endsWith(SEP + 'powerplants.edb'))).toHaveLength(1);
  // The open database's own workspace carries no file, which is what makes it the
  // one row that does NOT go looking in the folder.
  expect(values.filter((v) => v.endsWith(SEP))).toHaveLength(1);
});

test('picking the powerplants copy asks for powerplants.edb, not simon.edb', async ({ page, workspaceId }) => {
  await boot(page, workspaceId);
  await pickFile(page, 'powerplants.edb');

  const toast = page.locator('app-shell toast-host');
  await expect(toast).toContainText('powerplants.edb');
  await expect(toast).not.toContainText('simon.edb');
});

test('picking the simon copy asks for simon.edb', async ({ page, workspaceId }) => {
  await boot(page, workspaceId);
  await pickFile(page, 'simon.edb');

  const toast = page.locator('app-shell toast-host');
  await expect(toast).toContainText('simon.edb');
  await expect(toast).not.toContainText('powerplants.edb');
});
