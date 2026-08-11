import { test, expect } from './fixtures.js';
import { panelDomId } from './helpers.js';

/**
 * A column of lists should arrive typed `array` with the `tags` renderer, so its
 * cells show pills and its funnel offers the MEMBERS rather than whole cells.
 *
 * Two things stopped that. `['a', 'b']` — Python's spelling, and what a great
 * many exported CSVs hold — is not JSON, so it was read as one string and cut on
 * its commas into `['a` and `'b']`. And the rule was "EVERY non-empty cell is a
 * list", so a single `n/a` in a column of thousands left it a `string` column.
 * The rule is now a RUN of five consecutive non-empty cells.
 */

async function dropFile(page: import('@playwright/test').Page, filename: string, text: string, type: string) {
  await page.evaluate(
    async ({ filename, text, type }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      const file = new File([text], filename, { type });
      const dt = new DataTransfer();
      dt.items.add(file);
      const event = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
      for (const fn of ctx.registries.dropHandlers) {
        if (await fn(event, ctx.api)) break;
      }
    },
    { filename, text, type },
  );
}

/**
 * Drop a CSV and answer the "import straight away or review the columns?"
 * question. The drop's own promise cannot be awaited first — the handler is still
 * inside it, waiting for that answer.
 */
async function dropCsv(page: import('@playwright/test').Page, filename: string, text: string) {
  const dropped = dropFile(page, filename, text, 'text/csv');
  const dialogs = page.locator('host-dialogs');
  await expect(dialogs.getByText(/straight away/)).toBeVisible();
  await dialogs.locator('button.choice', { hasText: 'Import directly' }).click();
  await dropped;
}

const columnOf = (page: import('@playwright/test').Page, name: string, field: string) =>
  page.evaluate(
    async ({ name, field }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tables = await (window as any).__easydb.store.tables.find();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = tables.find((x: any) => x.name === name);
      if (!t) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = t.columns.find((x: any) => x.field === field);
      return c ? { id: t.id, type: c.type, renderer: c.renderer ?? null } : null;
    },
    { name, field },
  );

test('a column of single-quoted lists is typed array with the tags renderer', async ({ page }) => {
  const csv = ['name,tags', ...Array.from({ length: 6 }, (_, i) => `row${i},"['a${i}', 'b${i}']"`)].join('\n');
  await dropCsv(page, 'pylists.csv', csv);

  await expect.poll(() => columnOf(page, 'pylists', 'tags')).toMatchObject({ type: 'array', renderer: 'tags' });

  // And the members are the members — not the brackets and quotes the comma
  // split used to produce.
  const col = await columnOf(page, 'pylists', 'tags');
  const pills = page.locator(`#${panelDomId(col!.id)} data-table cell-tags .tag-pill`);
  await expect(pills.first()).toBeVisible();
  await expect(pills.filter({ hasText: 'a0' }).first()).toBeVisible();
  await expect(page.locator(`#${panelDomId(col!.id)} data-table`)).not.toContainText('[');
});

test('one stray cell no longer costs the column its type', async ({ page }) => {
  // Five lists in a row, then something that is not one. Under the old rule the
  // whole column stayed `string`.
  const csv = ['name,tags', ...Array.from({ length: 5 }, (_, i) => `row${i},"[""a${i}"",""b${i}""]"`), 'odd,n/a'].join('\n');
  await dropCsv(page, 'mostly.csv', csv);

  await expect.poll(() => columnOf(page, 'mostly', 'tags')).toMatchObject({ type: 'array', renderer: 'tags' });
});

test('a column of prose is left alone', async ({ page }) => {
  const csv = ['name,note', 'a,"Hello, world"', 'b,"one, two"', 'c,plain', 'd,"x, y"', 'e,text', 'f,more'].join('\n');
  await dropCsv(page, 'prose.csv', csv);

  await expect.poll(() => columnOf(page, 'prose', 'note')).toMatchObject({ type: 'string' });
});
