import { expect, test, type Page } from '@playwright/test';

/**
 * The workspace list does not change when you switch workspace.
 *
 * Reported twice, in the same words: _"when switching workspaces I see a different
 * list of workspaces"_. The list was built partly from `store.workspaces.find()` —
 * the database THIS TAB has open — and a tab holds exactly one database
 * (`tab-lock.ts`). So opening `sales.edb` dropped every workspace living in the
 * project index, and going back brought them all returning. The list was a
 * property of where the user was standing rather than of their setup.
 *
 * So the open database contributes NOTHING to the list. It is read from the folder
 * index and the space registry, both of which are `.edp` metadata — the folder's
 * `_easydb.edp` once one is connected (`device-state.ts`).
 *
 * The check below changes the ONE input the list still takes — `easydb:edb:active`,
 * the marker naming the database this tab has open — and asserts the list comes out
 * the same. Switching for real does more than this, but nothing else it does can
 * reach the list; and the marker is what the failing version keyed off.
 */

const INDEX_KEY = 'eda:folderIndex';
const REGISTRY_KEY = 'eda:spaceRegistry';
const ACTIVE_KEY = 'easydb:edb:active';

/** A folder holding three workspace files, and a project index holding a fourth. */
async function seed(page: Page, activeDb: string | null): Promise<void> {
  await page.addInitScript(
    ({ indexKey, registryKey, activeKey, active }) => {
      localStorage.setItem(
        indexKey,
        JSON.stringify({
          folder: 'e2e-stable',
          at: Date.now() - 60_000,
          files: ['alpha.edb', 'beta.edb', 'gamma.edb'],
          workspaces: [
            { id: 'alpha', title: 'Alpha', file: 'alpha.edb' },
            { id: 'beta', title: 'Beta', file: 'beta.edb' },
            { id: 'gamma', title: 'Gamma', file: 'gamma.edb' },
          ],
        }),
      );
      localStorage.setItem(
        registryKey,
        JSON.stringify({
          // No title on purpose: the tab that boots `?space=scratch` records what
          // the project index really holds, and a workspace whose typed name IS its
          // id is stored without one. Seeding a title here would be overwritten in
          // one run and not the other, which is a fact about the fixture rather
          // than about the list.
          'index.edp': [{ id: 'scratch' }],
          'alpha.edb': [{ id: 'alpha', title: 'Alpha' }],
        }),
      );
      if (active) localStorage.setItem(activeKey, active);
      else localStorage.removeItem(activeKey);
    },
    { indexKey: INDEX_KEY, registryKey: REGISTRY_KEY, activeKey: ACTIVE_KEY, active: activeDb },
  );
}

/** The list as the user reads it: the option labels, in order. */
async function listAt(page: Page, space: string, activeDb: string | null): Promise<string[]> {
  await seed(page, activeDb);
  await page.goto(`/?test=1&space=${encodeURIComponent(space)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  const options = page.locator('app-shell workspace-selector select option');
  await expect(options.first()).toBeAttached({ timeout: 20_000 });
  return options.allTextContents();
}

test('the same list from the project index and from inside a file', async ({ page }) => {
  const fromIndex = await listAt(page, 'scratch', null);
  const fromAlpha = await listAt(page, 'alpha', 'alpha.edb');
  const fromBeta = await listAt(page, 'beta', 'beta.edb');

  // Every workspace the setup holds, wherever the tab happens to be standing.
  expect(fromIndex).toEqual(['Alpha', 'Beta', 'Gamma', 'scratch']);
  expect(fromAlpha).toEqual(fromIndex);
  expect(fromBeta).toEqual(fromIndex);
});

test('the header names the workspace the tab is actually in', async ({ page }) => {
  // Every row carries the file that holds it now, so `selected` can no longer be
  // matched on "the row with no file". Matched on the id alone, the select shows
  // the open workspace rather than falling back to its first option.
  await seed(page, 'beta.edb');
  await page.goto('/?test=1&space=beta');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  const select = page.locator('app-shell workspace-selector select');
  await expect(select).toHaveValue(/^beta/, { timeout: 20_000 });
});

test('a workspace created in one database shows up from another', async ({ page }) => {
  // The registry is what carries it: the tab that has the project index open
  // records what it holds, and a tab inside a `.edb` — which cannot open the
  // index — reads that back.
  await seed(page, null);
  await page.goto('/?test=1&space=scratch');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    await ctx.store.workspaces.upsert({ id: 'later', title: 'Later', createdAt: Date.now(), pluginUrls: [] });
  });
  await expect(page.locator('app-shell workspace-selector select option', { hasText: 'Later' })).toHaveCount(1, { timeout: 20_000 });

  // Now from inside a file, with the registry carried across in localStorage.
  const registry = await page.evaluate((k) => localStorage.getItem(k), REGISTRY_KEY);
  await page.addInitScript(
    ({ registryKey, value, activeKey }) => {
      if (value) localStorage.setItem(registryKey, value);
      localStorage.setItem(activeKey, 'alpha.edb');
    },
    { registryKey: REGISTRY_KEY, value: registry, activeKey: ACTIVE_KEY },
  );
  await page.goto('/?test=1&space=alpha');
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 20_000 });
  await expect(page.locator('app-shell workspace-selector select option', { hasText: 'Later' })).toHaveCount(1, { timeout: 20_000 });
});
