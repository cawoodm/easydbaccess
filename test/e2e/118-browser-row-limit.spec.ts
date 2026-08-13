import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, liftRowLimit, readRows, waitForPanel } from './helpers.js';

/**
 * **A workspace in this browser holds 10,000 rows.** Past that, writes are refused.
 *
 * A hard limit rather than a warning, because the cost was measured and it is not
 * a matter of taste: in IndexedDB a 120,000-row table imports in 320 s, counts in
 * 5.3 s and filters in 5.9 s, where the same table in a `.edb` file imports in 12 s
 * and filters in 180 ms. 10,000 sits below the first crossing point (a per-column
 * filter, at about 12,000), so a workspace the app allows is one that feels quick.
 * See `.claude/plans/2026-08-13-sqlite-threshold.md`.
 *
 * The limit is per WORKSPACE, not per table: Dexie keeps every table's rows in one
 * store, so the cost degrades against all of them together.
 *
 * A `.edb` workspace has no limit at all — that is the way out, and the last test
 * here proves it is open.
 */

const ACTIVE_KEY = 'easydb:edb:active';
const LIMIT = 10_000;
const toast = (page: Page) => page.locator('toast-host');

/** Try to add `n` rows, and report the store's refusal instead of throwing. */
async function tryAdd(page: Page, tableId: string, n: number, from = 0): Promise<string> {
  return page.evaluate(
    async ({ tableId, n, from }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const docs = Array.from({ length: n }, (_, i) => ({
        id: crypto.randomUUID(),
        tableId,
        data: { name: `row ${from + i}` },
        updatedAt: Date.now(),
      }));
      try {
        await ctx.store.rows(tableId).bulkInsert(docs);
        return 'ok';
      } catch (err) {
        return (err as Error).message;
      }
    },
    { tableId, n, from },
  );
}

/**
 * `n` grouped the way the BROWSER groups it.
 *
 * The message is built in the page, so the page's locale is the authority: Node
 * here is Swiss (10’000) and Chromium is en-US (10,000). Formatting the
 * expectation in Node compared one locale against the other.
 */
async function grouped(page: Page, n: number): Promise<string> {
  return page.evaluate((v) => v.toLocaleString(), n);
}

async function countRows(page: Page, tableId: string): Promise<number> {
  return (await readRows(page, tableId)).length;
}

test('a write past the limit is refused, and nothing of it lands', async ({ page }) => {
  const id = await createTable(page, 'Big', [{ field: 'name' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'first' }]);

  const said = await tryAdd(page, id, LIMIT);
  expect(said).toContain(`${await grouped(page, LIMIT)} rows`);
  // The number it would have reached, and where to go instead.
  expect(said).toContain(await grouped(page, LIMIT + 1));
  expect(said).toContain('New .edb file');
  // Refused whole: an import that cannot fit must not leave half a file behind.
  expect(await countRows(page, id)).toBe(1);
});

test('the limit counts the whole workspace, not one table', async ({ page }) => {
  const a = await createTable(page, 'A', [{ field: 'name' }]);
  const b = await createTable(page, 'B', [{ field: 'name' }]);
  await waitForPanel(page, a);

  expect(await tryAdd(page, a, 6_000)).toBe('ok');
  // B is empty, but the workspace is not.
  expect(await tryAdd(page, b, 5_000)).toContain('holds');
  expect(await countRows(page, b)).toBe(0);
  // What does fit, fits.
  expect(await tryAdd(page, b, 4_000)).toBe('ok');
});

test('the last row that fits is allowed, and the next one is not', async ({ page }) => {
  const id = await createTable(page, 'Edge', [{ field: 'name' }]);
  await waitForPanel(page, id);
  expect(await tryAdd(page, id, LIMIT - 1)).toBe('ok');
  expect(await tryAdd(page, id, 1)).toBe('ok');
  expect(await tryAdd(page, id, 1)).toContain('holds');
  expect(await countRows(page, id)).toBe(LIMIT);
});

test('deleting rows gives the room back', async ({ page }) => {
  const id = await createTable(page, 'Churn', [{ field: 'name' }]);
  await waitForPanel(page, id);
  expect(await tryAdd(page, id, LIMIT)).toBe('ok');
  expect(await tryAdd(page, id, 1)).toContain('holds');

  await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = (await ctx.store.rows(tid).find()) as Array<{ id: string }>;
    await ctx.store.rows(tid).bulkRemove(rows.slice(0, 500).map((r) => r.id));
  }, id);

  expect(await tryAdd(page, id, 400)).toBe('ok');
});

test('a workspace already over the limit still reads, edits and deletes', async ({ page }) => {
  // What a user who filled a workspace before this rule existed comes back to. It
  // must not become unusable — only unable to grow.
  await liftRowLimit(page);
  const id = await createTable(page, 'Legacy', [{ field: 'name' }]);
  await waitForPanel(page, id);
  expect(await tryAdd(page, id, LIMIT + 500)).toBe('ok');

  await page.evaluate(() => {
    delete (window as unknown as { __easydbRowLimit?: number }).__easydbRowLimit;
  });

  // Editing a row is not adding one.
  const edited = await page.evaluate(async (tid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const rows = (await ctx.store.rows(tid).find()) as Array<{ id: string; data: Record<string, unknown> }>;
    const one = rows[0]!;
    await ctx.store.rows(tid).patch(one.id, { data: { ...one.data, name: 'edited' }, updatedAt: Date.now() });
    return (await ctx.store.rows(tid).findOne(one.id)).data.name;
  }, id);
  expect(edited).toBe('edited');
  // But adding one is.
  expect(await tryAdd(page, id, 1)).toContain('holds');
});

test('an import that is too big says so where the user can read it', async ({ page }) => {
  const rows = Array.from({ length: LIMIT + 1 }, (_, i) => `City ${i},${i}`).join('\n');
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="file"]').setInputFiles({
    name: 'places.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`city,pop\n${rows}\n`),
  });
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(toast(page).getByText(/holds .* rows/)).toBeVisible();
  await expect(toast(page).getByText(/New \.edb file/)).toBeVisible();
});

test('a workspace dump too big to fit is refused BEFORE the old one is deleted', async ({ page }) => {
  // The path that could have lost data: "Replace entire workspace" clears the
  // workspace and then inserts. Refused half way through the insert, the user would
  // be left with the old workspace gone and part of a new one. So the size is
  // judged first, while there is still nothing to lose. Same guard on a sync pull
  // and a gist pull, which do the same thing.
  const keep = await createTable(page, 'Keep', [{ field: 'name' }]);
  await waitForPanel(page, keep);
  await bulkAddRows(page, keep, [{ name: 'still here' }]);

  const dump = JSON.stringify({
    version: 1,
    exportedAt: Date.now(),
    tables: [
      {
        name: 'huge',
        columns: [{ field: 'name', label: 'Name', type: 'string' }],
        rows: Array.from({ length: LIMIT + 1 }, (_, i) => ({ name: `row ${i}` })),
      },
    ],
  });

  // A real drop on the document, so the app's own dispatcher runs and reports the
  // refusal the way the user sees it.
  await page.evaluate(
    ({ text }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], 'dump.db.json', { type: 'application/json' }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    },
    { text: dump },
  );

  await expect(toast(page).getByText(/Too much data for the browser|holds/)).toBeVisible();
  // The workspace it was going to replace is untouched.
  expect(await countRows(page, keep)).toBe(1);
  const names = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (await (window as any).__easydb.store.tables.find()) as Array<{ name: string }>;
    return all.map((t) => t.name);
  });
  expect(names).toEqual(['Keep']);
});

test('a workspace in a .edb file has no row limit', async ({ page, workspaceId }) => {
  // The whole point of the refusal: there is somewhere to go. Booted the way
  // `100-edb-browser` does it, because no file picker can be driven from here.
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: ACTIVE_KEY, value: `limit-${workspaceId}` });
  await page.goto(`/?test=1&space=${encodeURIComponent(workspaceId)}`);
  await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb), { timeout: 30_000 });

  const id = await createTable(page, 'Roomy', [{ field: 'name' }]);
  expect(await tryAdd(page, id, LIMIT + 2_000)).toBe('ok');
  expect(await countRows(page, id)).toBe(LIMIT + 2_000);
});
