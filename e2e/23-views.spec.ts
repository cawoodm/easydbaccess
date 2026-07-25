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

  test('the view footer "Edit template" link opens the editor and edits apply live', async ({
    page,
  }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello World', url: 'https://example.com/1' }]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('a', { hasText: 'Hello World' })).toBeVisible();

    // The view's footer has an "Edit template" link → opens the template editor.
    await vw.locator('.vw-footer .edit-template').click();
    await expect(dlg.locator('.dialog-header h2')).toContainText('Edit template');
    // The RSS template's fields are loaded (name populated).
    await expect(dlg.locator('input[type="text"]')).toHaveValue('RSS Feed');

    // Rewrite the row HTML with a distinctive marker, keeping the $TITLE token.
    await dlg.locator('textarea').nth(1).fill('<div class="edited">$TITLE</div>');
    await dlg.getByRole('button', { name: 'Save' }).click();

    // The open view re-renders with the edited template (no manual reload).
    await expect(vw.locator('div.edited', { hasText: 'Hello World' })).toBeVisible();
  });

  test('the view footer "Edit view" icon opens the instance editor', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello World', url: 'https://example.com/1' }]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('a', { hasText: 'Hello World' })).toBeVisible();

    // The footer "Edit view" icon deep-links into this instance's editor
    // (rename + token→column mapping), pre-filled with the view's name.
    await vw.getByRole('button', { name: 'Edit view' }).click();
    await expect(dlg.locator('.dialog-header h2')).toContainText('Edit view');
    await expect(dlg.locator('input[type="text"]').first()).toHaveValue(/RSS Feed — Feed/);
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

  test('an open view window reopens after a browser reload', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://example.com/1' }]);

    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    await expect(page.locator('view-window')).toBeVisible();

    // Reload the browser — the view instance persists and its window should be
    // re-created on boot (jsPanel itself has no cross-reload memory).
    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    await expect(vw.locator('a', { hasText: 'Hello' })).toBeVisible();

    // Closing the window clears the persisted open flag → it does NOT reopen.
    await page.locator('[id^="view-panel-"] .jsPanel-btn-close').first().click();
    await expect(page.locator('view-window')).toHaveCount(0);
    // Wait for the open=false patch to commit before reloading (the close-time
    // persist is async), otherwise the reload could read a stale open flag.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.viewInstances.find();
          return all.every((i: { open?: boolean }) => !i.open);
        }),
      )
      .toBe(true);
    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await page.waitForTimeout(300);
    await expect(page.locator('view-window')).toHaveCount(0);
  });

  test('a minimized view window is still minimized after a reload', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://example.com/1' }]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    const viewPanel = page.locator('[id^="view-panel-"]');
    await expect(viewPanel).toBeVisible();

    // Minimize the view → it docks bottom-left as a replacement bar.
    await viewPanel.locator('.jsPanel-btn-minimize').click();
    const dockBar = page.locator('#easydb-minimized-dock .jsPanel-replacement');
    await expect(dockBar).toBeVisible();

    // Wait for the minimized state to persist before reloading (the geometry
    // save on status change is async), otherwise the reload could read a stale
    // geometry and restore the window normalized.
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ctx = (window as any).__easydb;
          const all = await ctx.store.viewInstances.find();
          return all.some(
            (i: { windowGeometry?: { minimized?: boolean } }) => i.windowGeometry?.minimized,
          );
        }),
      )
      .toBe(true);

    // Reload → the view reopens AND is restored to its minimized (docked) state,
    // not popped open normalized.
    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await expect(page.locator('#easydb-minimized-dock .jsPanel-replacement')).toBeVisible();
  });

  test('a maximized view window fills the area and stays filling through a pan', async ({
    page,
  }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://example.com/1' }]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    const viewPanel = page.locator('[id^="view-panel-"]');
    await expect(viewPanel).toBeVisible();

    const overlay = (await page.locator('#easydb-panels').boundingBox())!;
    await viewPanel.locator('.jsPanel-btn-maximize').click();
    await page.waitForTimeout(120);

    // Right-drag pan the canvas while maximized → the view stays pinned filling
    // the overlay (core maximize-fill counter-transform, shared with tables).
    await page.mouse.move(overlay.x + 300, overlay.y + 200);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(overlay.x + 520, overlay.y + 360, { steps: 6 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(80);

    const box = (await viewPanel.boundingBox())!;
    expect(Math.abs(box.x - overlay.x)).toBeLessThan(4);
    expect(Math.abs(box.y - overlay.y)).toBeLessThan(4);
    expect(Math.abs(box.width - overlay.width)).toBeLessThan(4);
    expect(Math.abs(box.height - overlay.height)).toBeLessThan(4);
  });

  test('the view header has the core search box and it filters the view rows', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Alpha', url: 'https://example.com/a' },
      { title: 'Beta', url: 'https://example.com/b' },
    ]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    const viewPanel = page.locator('[id^="view-panel-"]');
    await expect(viewPanel).toBeVisible();
    const vw = page.locator('view-window');
    await expect(vw.locator('a')).toHaveCount(2);

    // The core search box lives in the view's titlebar controlbar. Open it and
    // type — the view's rows filter down (independently of the table window).
    const search = viewPanel.locator('.jsPanel-controlbar panel-search');
    await expect(search).toHaveCount(1);
    await search.getByRole('button').click();
    await search.locator('input').fill('Alpha');
    await expect(vw.locator('a')).toHaveCount(1);
    await expect(vw.locator('a', { hasText: 'Alpha' })).toBeVisible();
  });

  test('the footer table toggle switches the template off to an interactive grid, stored on the instance', async ({
    page,
    workspaceId,
  }) => {
    const id = await createTable(page, 'Feed', [
      { field: 'title' },
      { field: 'url' },
      { field: 'date' },
      { field: 'description' },
    ]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Hello World', url: 'https://example.com/1', date: '2024-01-01', description: 'a' },
      { title: 'Second Post', url: 'https://example.com/2', date: '2024-01-02', description: 'b' },
    ]);

    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    // Template ON: linked cards, no grid.
    await expect(vw.locator('a')).toHaveCount(2);
    await expect(vw.locator('data-table')).toHaveCount(0);

    // Toggle the template OFF via the footer table icon → the interactive grid.
    await vw.getByRole('button', { name: 'Toggle template' }).click();
    const grid = vw.locator('data-table');
    await expect(grid).toBeVisible();
    await expect(grid.locator('tbody tr')).toHaveCount(2);
    await expect(vw.locator('a')).toHaveCount(0); // template anchors gone

    // Sorting in the grid persists on the VIEW INSTANCE, not the table.
    await grid.locator('thead th').first().click(); // sort by first column asc
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const inst = (await store.viewInstances.find({ workspaceId: ws }))[0];
          return inst?.sortColumn ?? null;
        }, workspaceId),
      )
      .toBe('title');
    const tableSort = await page.evaluate(async (tid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      return (await store.tables.findOne(tid))?.sortColumn ?? null;
    }, id);
    expect(tableSort).toBeNull(); // the underlying table's sort is untouched

    // Hide a column via the footer columns menu → persisted on the instance.
    await vw.getByRole('button', { name: 'Columns' }).click();
    await vw.locator('.cols-menu label', { hasText: 'description' }).locator('input').uncheck();
    // Data-column headers carry a title attribute; the trailing action th does
    // not. Started with 4 columns → 3 after hiding "description".
    await expect(grid.locator('thead tr').first().locator('th[title]')).toHaveCount(3);
    const visible = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      return (await store.viewInstances.find({ workspaceId: ws }))[0]?.visibleColumns ?? [];
    }, workspaceId);
    expect(visible).not.toContain('description');

    // Toggle back ON → the template renders again.
    await vw.getByRole('button', { name: 'Toggle template' }).click();
    await expect(vw.locator('a')).toHaveCount(2);
    await expect(vw.locator('data-table')).toHaveCount(0);
  });

  test('a column filter in the grid is not reverted by a concurrent instance write', async ({
    page,
    workspaceId,
  }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Alpha', url: 'x' },
      { title: 'Beta', url: 'y' },
    ]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await vw.getByRole('button', { name: 'Toggle template' }).click();
    const grid = vw.locator('data-table');
    await expect(grid.locator('tbody tr')).toHaveCount(2);

    // Type a column filter, then — while the debounced save is still pending —
    // force a viewInstances write (a geometry save / auto-sync would do this in
    // the wild). The filter must survive rather than revert to "all rows".
    await grid.locator('tr.filter-row filter-combobox input').first().fill('Alpha');
    await expect(grid.locator('tbody tr')).toHaveCount(1);
    await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const inst = (await store.viewInstances.find({ workspaceId: ws }))[0];
      await store.viewInstances.patch(inst.id, { updatedAt: Date.now() });
    }, workspaceId);
    await page.waitForTimeout(700); // past the 250ms filter debounce

    await expect(grid.locator('tbody tr')).toHaveCount(1);
    const persisted = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      return (await store.viewInstances.find({ workspaceId: ws }))[0]?.filters ?? {};
    }, workspaceId);
    expect(persisted).toMatchObject({ title: 'Alpha' });
  });

  test('toggling back to the template shows the rows filtered in the grid', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Alpha', url: 'https://example.com/a' },
      { title: 'Beta', url: 'https://example.com/b' },
    ]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg
      .locator('ul.list li', { hasText: 'RSS Feed' })
      .getByRole('button', { name: 'Use' })
      .click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('a')).toHaveCount(2); // template: 2 cards

    // Turn the template off, filter to a single row in the grid…
    await vw.getByRole('button', { name: 'Toggle template' }).click();
    const grid = vw.locator('data-table');
    await grid.locator('tr.filter-row filter-combobox input').first().fill('Alpha');
    await expect(grid.locator('tbody tr')).toHaveCount(1);
    await page.waitForTimeout(400); // let the filter persist to the instance

    // …then toggle the template back on — it must show the SAME filtered row.
    await vw.getByRole('button', { name: 'Toggle template' }).click();
    await expect(vw.locator('data-table')).toHaveCount(0);
    await expect(vw.locator('a')).toHaveCount(1);
    await expect(vw.locator('a', { hasText: 'Alpha' })).toBeVisible();
  });
});
