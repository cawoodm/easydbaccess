import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The View system: a workspace-global HTML template + per-table instances shown
 * read-only in their own windows. Covers the seeded RSS template (row HTML →
 * repeated cards) and the blank-row-HTML fallback (read-only columns table).
 */
test.describe('views', () => {
  test('RSS template renders a table as a list of linked cards', async ({ page }) => {
    const id = await createTable(page, 'Feed', [
      { field: 'title' },
      { field: 'url' },
      { field: 'date' },
      { field: 'description' },
    ]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      {
        title: 'Hello World',
        url: 'https://example.com/1',
        date: '2024-01-01',
        description: 'First post',
      },
      {
        title: 'Second Post',
        url: 'https://example.com/2',
        date: '2024-01-02',
        description: 'Another',
      },
    ]);

    // The footer "Views" icon opens the manager.
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();

    // The built-in RSS Feed template is listed; "Use" it.
    const rss = dlg.locator('ul.list li', { hasText: 'RSS Feed' });
    await expect(rss).toBeVisible();
    await expect(rss.locator('.badge')).toHaveText('built-in');
    await rss.getByRole('button', { name: 'Use' }).click();

    // Tokens auto-mapped by name (TITLE→title, URL→url, …) → create the view.
    await dlg.getByRole('button', { name: 'Create view' }).click();

    // A view window opens rendering one linked card per row.
    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    await expect(vw.locator('a')).toHaveCount(2);
    const first = vw.locator('a', { hasText: 'Hello World' });
    await expect(first).toBeVisible();
    await expect(first).toHaveAttribute('href', 'https://example.com/1');
    // No editable inputs — the view is read-only.
    await expect(vw.locator('input')).toHaveCount(0);
  });

  test('an existing view instance can be renamed and re-mapped', async ({ page }) => {
    const id = await createTable(page, 'Feed', [
      { field: 'title' },
      { field: 'url' },
      { field: 'date' },
      { field: 'description' },
    ]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      {
        title: 'Hello World',
        url: 'https://example.com/1',
        date: '2024-01-01',
        description: 'First post',
      },
    ]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();

    // Create an RSS view (auto-mapped: $TITLE → title).
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('a', { hasText: 'Hello World' })).toBeVisible();

    // Reopen the manager; the instance is listed with an Edit action.
    await footer.getByRole('button', { name: /Views/ }).click();
    await expect(dlg).toBeVisible();
    const inst = dlg.locator('ul.list li', { hasText: 'RSS Feed — Feed' });
    await inst.getByRole('button', { name: 'Edit' }).click();

    // Rename it and re-map $TITLE from the title column to description.
    await expect(dlg.locator('.dialog-header h2')).toContainText('Edit view');
    await dlg.locator('input[type="text"]').fill('My Renamed Feed');
    await dlg
      .locator('.map-row', { hasText: '$TITLE' })
      .locator('select')
      .selectOption({ label: 'description' });
    await dlg.getByRole('button', { name: 'Save' }).click();

    // Back in the list, the new name shows; the open window reloaded so the
    // card's link now renders the description value ("First post").
    await expect(dlg.locator('ul.list li', { hasText: 'My Renamed Feed' })).toBeVisible();
    await expect(vw.locator('a', { hasText: 'First post' })).toBeVisible();
    await expect(vw.locator('a', { hasText: 'Hello World' })).toHaveCount(0);
  });

  test('a stale built-in RSS template is reconciled to the shipped HTML on reload', async ({
    page,
  }) => {
    // Force the RSS template to be seeded, then simulate a workspace that was
    // provisioned by an OLD release: overwrite the built-in template's row HTML
    // with a version that lacks the line-clamp, and set a bogus stored
    // signature. On reload, seedDefaults must patch it back to the shipped HTML.
    const id = await createTable(page, 'Seeded', [{ field: 'title' }]);
    await waitForPanel(page, id);

    const staleRow = '<div>$DESCRIPTION</div>';
    await page.evaluate(
      async ({ staleRow }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ctx = (window as any).__easydb;
        const wsId = ctx.workspaceId;
        const tpls = await ctx.store.viewTemplates.find({ workspaceId: wsId });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rss = tpls.find((t: any) => t.builtin && t.name === 'RSS Feed');
        await ctx.store.viewTemplates.patch(rss.id, { rowHtml: staleRow });
        await ctx.store.settings.upsert({ key: `views:sig:rss:${wsId}`, value: 'stale' });
      },
      { staleRow },
    );

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );

    // The built-in template's row HTML now carries the shipped line-clamp again.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const tpls = await ctx.store.viewTemplates.find({ workspaceId: ctx.workspaceId });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rss = tpls.find((t: any) => t.builtin && t.name === 'RSS Feed');
          return rss?.rowHtml ?? '';
        }),
      )
      .toContain('line-clamp:20');
  });

  test('a template with blank row HTML falls back to a read-only columns table', async ({
    page,
  }) => {
    const id = await createTable(page, 'Plain', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { a: 'one', b: 'uno' },
      { a: 'two', b: 'dos' },
    ]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();

    // New template: header + footer HTML, blank row HTML.
    await dlg.getByRole('button', { name: '+ New template' }).click();
    await dlg.locator('input[type="text"]').fill('Bare');
    const areas = dlg.locator('textarea');
    await areas.nth(0).fill('<h4 class="hdr">Report</h4>'); // header
    // row HTML left blank → table fallback
    await areas.nth(2).fill('<p class="ftr">end</p>'); // footer
    await dlg.getByRole('button', { name: 'Save' }).click();

    // Use the new template → no tokens → create directly.
    await dlg
      .locator('ul.list li', { hasText: 'Bare' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    // The view shows the header/footer HTML around a read-only table (2 rows).
    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    await expect(vw.locator('h4.hdr')).toHaveText('Report');
    await expect(vw.locator('p.ftr')).toHaveText('end');
    await expect(vw.locator('table.vw-table tbody tr')).toHaveCount(2);
    await expect(vw.locator('input')).toHaveCount(0);
  });
});
