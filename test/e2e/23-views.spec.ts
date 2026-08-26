import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel, waitForViewTemplates } from './helpers.js';

/**
 * The View system: a workspace-global HTML template + per-table instances shown
 * read-only in their own windows. Covers the seeded RSS template (row HTML →
 * repeated cards) and the blank-row-HTML fallback (read-only columns table).
 */
test.describe('views', () => {
  test('RSS template renders a table as a list of linked cards', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }, { field: 'date' }, { field: 'description' }]);
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
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }, { field: 'date' }, { field: 'description' }]);
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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
    await dlg.locator('.map-row', { hasText: '$TITLE' }).locator('select').selectOption({ label: 'description' });
    await dlg.getByRole('button', { name: 'Save' }).click();

    // Back in the list, the new name shows; the open window reloaded so the
    // card's link now renders the description value ("First post").
    await expect(dlg.locator('ul.list li', { hasText: 'My Renamed Feed' })).toBeVisible();
    await expect(vw.locator('a', { hasText: 'First post' })).toBeVisible();
    await expect(vw.locator('a', { hasText: 'Hello World' })).toHaveCount(0);
  });

  test('the view footer "Edit template" link opens the editor and edits apply live', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello World', url: 'https://example.com/1' }]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('a', { hasText: 'Hello World' })).toBeVisible();

    // The footer "Edit view" icon deep-links into this instance's editor
    // (rename + token→column mapping), pre-filled with the view's name.
    await vw.getByRole('button', { name: 'Edit view' }).click();
    await expect(dlg.locator('.dialog-header h2')).toContainText('Edit view');
    await expect(dlg.locator('input[type="text"]').first()).toHaveValue(/RSS Feed — Feed/);
  });

  test('a stale built-in RSS template is reconciled to the shipped HTML on reload', async ({ page }) => {
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
        await ctx.store.settings.upsert({ name: `views:sig:rss:${wsId}`, value: 'stale' });
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

  test('a template with blank row HTML falls back to a read-only columns table', async ({ page }) => {
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
    await dlg.locator('ul.list li', { hasText: 'Bare' }).getByRole('button', { name: 'Use' }).click();
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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
          return all.some((i: { windowGeometry?: { minimized?: boolean } }) => i.windowGeometry?.minimized);
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

  test('a maximized view window fills the area and stays filling through a pan', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://example.com/1' }]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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

  test('double-clicking a view titlebar maximizes it, and again restores', async ({ page }) => {
    // Mirrors 21-maximize.spec.ts's table-window version. Dblclicking a view
    // window's titlebar toggles maximize, generically provided for every
    // panel kind by the panel shell (`panel-shell.ts`'s `hdr` dblclick
    // handler), including the maximized-cursor swap.
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://example.com/1' }]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    const viewPanel = page.locator('[id^="view-panel-"]');
    await expect(viewPanel).toBeVisible();

    const status = () => viewPanel.evaluate((el) => (el as HTMLElement & { status: string }).status);
    const title = viewPanel.locator('.jsPanel-title');
    const titlebarCursor = () => viewPanel.locator('.jsPanel-titlebar').evaluate((el) => getComputedStyle(el as HTMLElement).cursor);

    expect(await status()).toBe('normalized');
    expect(await titlebarCursor()).toBe('move');

    await title.dblclick();
    await page.waitForTimeout(120);
    expect(await status()).toBe('maximized');
    expect(await titlebarCursor()).toBe('pointer');

    await title.dblclick();
    await page.waitForTimeout(120);
    expect(await status()).toBe('normalized');
    expect(await titlebarCursor()).toBe('move');
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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

  test('the footer table toggle switches the template off to an interactive grid, stored on the instance', async ({ page, workspaceId }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }, { field: 'date' }, { field: 'description' }]);
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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

    // Hide a column via the view's own column editor → persisted on the instance.
    // (Was a checkbox popover in the footer until v0.0.434; the editor also owns
    // the per-view renderer — see `129-view-columns-editor.spec.ts`.)
    await vw.getByRole('button', { name: 'Columns' }).click();
    const colsEditor = page.locator('view-columns-dialog dialog');
    await expect(colsEditor).toBeVisible({ timeout: 10_000 });
    await colsEditor.getByLabel('Show description', { exact: false }).uncheck();
    await colsEditor.getByRole('button', { name: 'Done' }).click();
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

  test('a column filter in the grid is not reverted by a concurrent instance write', async ({ page, workspaceId }) => {
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
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

  test('global search filters a template view and respects the view’s own search', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }, { field: 'city' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Alice', url: 'https://example.com/a', city: 'Paris' },
      { title: 'Bob', url: 'https://example.com/b', city: 'London' },
      { title: 'Carol', url: 'https://example.com/c', city: 'Paris' },
    ]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('a')).toHaveCount(3); // template on: one card per row

    // The app-wide global search filters the view's rows too.
    const header = page.locator('app-shell header');
    await header.locator('button.icon-btn[title^="Search"]').click();
    const gsearch = header.locator('input.search');
    await gsearch.fill('Alice');
    await expect(vw.locator('a')).toHaveCount(1);
    await expect(vw.locator('a', { hasText: 'Alice' })).toBeVisible();
    await gsearch.fill('');
    await expect(vw.locator('a')).toHaveCount(3);

    // Give the view its OWN search (city "Paris" → Alice + Carol).
    const viewPanel = page.locator('[id^="view-panel-"]');
    const vsearch = viewPanel.locator('.jsPanel-controlbar panel-search');
    await vsearch.getByRole('button').click();
    await vsearch.locator('input').fill('Paris');
    await expect(vw.locator('a')).toHaveCount(2);

    // Global search now intersects with (respects) the view's search: Carol is
    // in Paris → shown; Bob is not → global "Bob" leaves nothing.
    await header.locator('button.icon-btn[title^="Search"]').click();
    const gsearch2 = header.locator('input.search');
    await gsearch2.fill('Carol');
    await expect(vw.locator('a')).toHaveCount(1);
    await expect(vw.locator('a', { hasText: 'Carol' })).toBeVisible();
    await gsearch2.fill('Bob');
    await expect(vw.locator('a')).toHaveCount(0);
  });
});

/**
 * A live <view-window> subscribes to the underlying table's rows as soon as it
 * connects — which, for a remote table, fetches. So a minimized view must not be
 * mounted at all: it holds no rows and runs no subscription until it's expanded.
 * Mirrors the table windows' lazy grid.
 */
test.describe('minimized views load nothing until expanded', () => {
  /**
   * Creates a table + an RSS view over it through the real UI. Returns the view
   * PANEL's dom id — the panel outlives its content, so it stays a valid handle
   * once the view is detached (a `.jsPanel` that *has* a view-window would not).
   */
  async function makeView(page: import('@playwright/test').Page): Promise<string> {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }, { field: 'date' }, { field: 'description' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'One', url: 'https://example.com/1', date: '2024-01-01', description: 'a' },
      { title: 'Two', url: 'https://example.com/2', date: '2024-01-02', description: 'b' },
    ]);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
    await expect(page.locator('view-window')).toBeVisible();
    return page.evaluate(() => document.querySelector('view-window')!.closest('.jsPanel')!.id);
  }

  const minimize = (page: import('@playwright/test').Page, panelId: string) => page.locator(`#${panelId}`).evaluate((el) => (el as HTMLElement & { minimize(): void }).minimize());
  const restore = (page: import('@playwright/test').Page, panelId: string) => page.locator(`#${panelId}`).evaluate((el) => (el as HTMLElement & { normalize(): void }).normalize());

  test('minimizing detaches the view; restoring mounts a fresh one', async ({ page }) => {
    const panelId = await makeView(page);
    const title = page.locator(`#${panelId} .jsPanel-title`);

    // Mounted, with a row count in the title.
    await expect(page.locator('view-window')).toHaveCount(1);
    await expect(title).toContainText('(2)');

    await minimize(page, panelId);
    // Detached entirely — no element, so no rows held and no subscription.
    await expect(page.locator('view-window')).toHaveCount(0);
    // And the stale count is dropped rather than left lying in the title.
    await expect(title).not.toContainText('(2)');

    // Restoring mounts a fresh view that loads and counts again.
    await restore(page, panelId);
    await expect(page.locator('view-window')).toHaveCount(1);
    await expect(title).toContainText('(2)');
  });

  test('a view that boots minimized is never mounted', async ({ page }) => {
    const panelId = await makeView(page);
    await minimize(page, panelId);
    await expect(page.locator('view-window')).toHaveCount(0);

    // The minimized state is persisted, so a reload must restore it WITHOUT
    // ever mounting the view — this is the case that used to load eagerly.
    await page.reload();
    await page.waitForFunction(() => Boolean((window as unknown as { __easydb?: unknown }).__easydb));
    await expect(page.locator(`#${panelId}`)).toHaveCount(1);
    await expect(page.locator('view-window')).toHaveCount(0);

    // Expanding it loads for the first time.
    await restore(page, panelId);
    await expect(page.locator('view-window')).toHaveCount(1);
    await expect(page.locator('view-window a')).toHaveCount(2);
  });

  test('an $input.TOKEN renders an editable checkbox that writes back to the row', async ({ page }) => {
    const id = await createTable(page, 'Flags', [{ field: 'title' }, { field: 'read', type: 'boolean' }, { field: 'starred', type: 'boolean' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Post A', read: false, starred: false }]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    // The RSS template's $input.CHECK1 / $input.CHECK2 auto-mapped to the two
    // boolean columns → two checkboxes, captioned with the column labels, unticked.
    const checks = vw.locator('input[type="checkbox"].eda-input');
    await expect(checks).toHaveCount(2);
    const readBox = vw.locator('label.eda-input-field', { hasText: 'read' }).locator('input');
    await expect(readBox).not.toBeChecked();

    // Ticking it writes read=true straight back to the underlying row.
    await readBox.click();
    await expect
      .poll(() =>
        page.evaluate(async (tid) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows = await (window as any).__easydb.store.rows(tid).find();
          return rows[0].data.read;
        }, id),
      )
      .toBe(true);
  });

  test('editing an $input checkbox re-applies the view filter so the row can disappear', async ({ page }) => {
    const id = await createTable(page, 'Flags', [{ field: 'title' }, { field: 'read', type: 'boolean' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Unread post', read: false }]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    const readBox = vw.locator('label.eda-input-field', { hasText: 'read' }).locator('input');
    await expect(readBox).toBeVisible();

    // Filter the view to show only NOT-read rows (`!true`) — the "mark read →
    // hide it" pattern from the request. The row (read=false) still shows.
    await page.evaluate(async (tid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inst = (await store.viewInstances.find()).find((v: any) => v.tableId === tid);
      await store.viewInstances.patch(inst.id, { filters: { read: '!true' }, updatedAt: Date.now() });
    }, id);
    await expect(readBox).toBeVisible();

    // Tick it read → read=true no longer matches `!true` → the card disappears.
    await readBox.click();
    await expect(vw.locator('input[type="checkbox"].eda-input')).toHaveCount(0);
  });

  test('a readonly view disables its $input controls', async ({ page }) => {
    const id = await createTable(page, 'Flags', [{ field: 'title' }, { field: 'read', type: 'boolean' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Post', read: false }]);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    // Tick "Readonly" before creating the view → the input renders disabled.
    await dlg.locator('label.field-inline', { hasText: 'Readonly' }).locator('input[type="checkbox"]').check();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    await expect(vw.locator('input[type="checkbox"].eda-input')).toBeDisabled();
  });
});

/**
 * The view top-bar sort dropdown, field-scoped search inside a view, and the
 * additional seeded standard templates (Todo List, Gallery, Contact Cards).
 */
test.describe('views: sort, field search, standard templates', () => {
  const useTemplate = async (page: import('@playwright/test').Page, tableId: string, templateName: string) => {
    const footer = page.locator(`#${panelDomId(tableId)} panel-footer`);
    await footer.getByRole('button', { name: /Views/ }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('ul.list li', { hasText: templateName }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();
  };

  test('the top-bar sort dropdown reorders template rows', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'n', type: 'number' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'Bravo', n: 2 },
      { title: 'Alpha', n: 1 },
      { title: 'Charlie', n: 3 },
    ]);
    await useTemplate(page, id, 'RSS Feed');

    const vw = page.locator('view-window');
    await expect(vw.locator('a')).toHaveCount(3);

    // Sort by title ascending → Alpha first.
    await vw.locator('.vw-sortbar select').selectOption({ label: 'title' });
    await expect(vw.locator('a').first()).toHaveText('Alpha');

    // Flip direction → descending → Charlie first.
    await vw.locator('.vw-sortbar button[aria-label="Toggle sort direction"]').click();
    await expect(vw.locator('a').first()).toHaveText('Charlie');
  });

  test('a view search supports field:value scoping', async ({ page }) => {
    const id = await createTable(page, 'People', [{ field: 'name' }, { field: 'city' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { name: 'Ann', city: 'Paris' },
      { name: 'Bob', city: 'London' },
      { name: 'Cara', city: 'Paris' },
    ]);
    await useTemplate(page, id, 'RSS Feed');

    const vw = page.locator('view-window');
    await expect(vw.locator('a')).toHaveCount(3);

    const viewPanel = page.locator('[id^="view-panel-"]');
    const vsearch = viewPanel.locator('.jsPanel-controlbar panel-search');
    await vsearch.getByRole('button').click();
    await vsearch.locator('input').fill('city:Paris');
    await expect(vw.locator('a')).toHaveCount(2);
    await vsearch.locator('input').fill('city:London');
    await expect(vw.locator('a')).toHaveCount(1);
  });

  test('the new standard templates are seeded and listed', async ({ page }) => {
    const id = await createTable(page, 'T', [{ field: 'a' }]);
    await waitForPanel(page, id);
    await waitForViewTemplates(page);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    for (const name of ['RSS Feed', 'Todo List', 'Gallery', 'Contact Cards']) {
      await expect(dlg.locator('ul.list li', { hasText: name })).toBeVisible();
    }
  });

  test('the Todo template maps DONE to a boolean column as a checkbox', async ({ page }) => {
    const id = await createTable(page, 'Tasks', [{ field: 'title' }, { field: 'done', type: 'boolean' }, { field: 'due', type: 'date' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Ship it', done: false, due: '2024-01-01' }]);
    await useTemplate(page, id, 'Todo List');

    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    await expect(vw.locator('input[type="checkbox"].eda-input')).toHaveCount(1);
    await expect(vw).toContainText('Ship it');
  });

  test('the Gallery template makes each card open its row link', async ({ page }) => {
    const id = await createTable(page, 'Shots', [{ field: 'title' }, { field: 'image' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { title: 'First', image: 'https://pics.test/1.png', url: 'https://pics.test/1' },
      { title: 'Second', image: 'https://pics.test/2.png', url: 'https://pics.test/2' },
    ]);
    // $LINK auto-maps to the url column (it is one of the URL words), $IMAGE to
    // image and $TITLE to title.
    await useTemplate(page, id, 'Gallery');

    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    const cards = vw.locator('figure');
    await expect(cards).toHaveCount(2);
    // The view has no sort, so the cards come in row-id order — which is random,
    // the ids being uuids. Assert per card that its OWN row's values line up,
    // and that both rows are present, rather than pinning either position.
    for (const n of [0, 1]) {
      const a = cards.nth(n).locator('a');
      await expect(a).toHaveAttribute('target', '_blank');
      const href = (await a.getAttribute('href'))!;
      expect(href).toMatch(/^https:\/\/pics\.test\/[12]$/);
      // Each card is one anchor wrapping the image and its caption, all from the
      // same row: card 1's link never carries card 2's picture.
      await expect(a.locator('img')).toHaveAttribute('src', `${href}.png`);
      await expect(a).toContainText(href.endsWith('1') ? 'First' : 'Second');
    }
    const hrefs = await cards.locator('a').evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).getAttribute('href')));
    expect([...hrefs].sort()).toEqual(['https://pics.test/1', 'https://pics.test/2']);
  });

  test('copying a view picks up columns added to the table after it was created', async ({ page, workspaceId }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://x/1' }]);
    await useTemplate(page, id, 'RSS Feed'); // snapshots visibleColumns = [title, url]

    // Add a new column to the table AFTER the view already exists.
    await page.evaluate(async (tid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = await store.tables.findOne(tid);
      await store.tables.patch(tid, {
        columns: [...t.columns, { field: 'author', label: 'author', type: 'string' }],
        updatedAt: Date.now(),
      });
    }, id);

    // Reopen the Views manager and Copy the instance.
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('ul.list li', { hasText: 'RSS Feed — Feed' }).getByRole('button', { name: 'Copy' }).click();

    // The copy carries the NEW column in its visibleColumns; the original — a
    // pre-existing snapshot — does not.
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const insts = (await store.viewInstances.find()).filter((v: { workspaceId: string }) => v.workspaceId === ws);
          const copy = insts.find((v: { name: string }) => v.name.endsWith('copy'));
          const orig = insts.find((v: { name: string }) => v.name === 'RSS Feed — Feed');
          return {
            copyHasAuthor: copy ? copy.visibleColumns.includes('author') : null,
            origHasAuthor: orig ? orig.visibleColumns.includes('author') : null,
          };
        }, workspaceId),
      )
      .toEqual({ copyHasAuthor: true, origHasAuthor: false });
  });

  test('the view footer Delete button removes the view and closes its window', async ({ page, workspaceId }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://x/1' }]);
    await useTemplate(page, id, 'RSS Feed');

    const vw = page.locator('view-window');
    await expect(vw).toBeVisible();
    await vw.getByRole('button', { name: 'Delete view' }).click();
    await page.locator('host-dialogs').getByRole('button', { name: 'Yes' }).click();

    // The instance is gone from the store, and the manager closed the window.
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const insts = (await store.viewInstances.find()).filter((v: { workspaceId: string }) => v.workspaceId === ws);
          return insts.length;
        }, workspaceId),
      )
      .toBe(0);
    await expect(vw).toHaveCount(0);
  });

  test('a built-in template can be deleted after a confirm, and stays deleted', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }]);
    await waitForPanel(page, id);
    const openManager = async () => {
      await page
        .locator(`#${panelDomId(id)} panel-footer`)
        .getByRole('button', { name: /Views/ })
        .click();
      const dlg = page.locator('views-dialog dialog');
      await expect(dlg).toBeVisible();
      return dlg;
    };
    let dlg = await openManager();

    const rss = dlg.locator('ul.list li', { hasText: 'RSS Feed' }).first();
    await expect(rss.locator('.badge')).toHaveText('built-in');

    // The confirm names it as built-in and says it will not be seeded again.
    await rss.getByRole('button', { name: 'Delete' }).click();
    const dialogs = page.locator('host-dialogs');
    await expect(dialogs.getByText(/built-in template "RSS Feed"/)).toBeVisible();
    await expect(dialogs.getByText(/not be seeded again/)).toBeVisible();
    await dialogs.getByRole('button', { name: 'Yes', exact: true }).click();
    await expect(dlg.locator('ul.list li', { hasText: 'RSS Feed' })).toHaveCount(0);

    // A reload does not bring it back: the seeder only seeds a slug it has never
    // seeded in this workspace.
    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, id);
    dlg = await openManager();
    await expect(dlg.locator('ul.list li', { hasText: 'Gallery' })).toBeVisible();
    await expect(dlg.locator('ul.list li', { hasText: 'RSS Feed' })).toHaveCount(0);
  });

  test('declining the confirm keeps the template', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }]);
    await waitForPanel(page, id);
    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    const rss = dlg.locator('ul.list li', { hasText: 'RSS Feed' }).first();
    await rss.getByRole('button', { name: 'Delete' }).click();
    await page.locator('host-dialogs').getByRole('button', { name: 'No', exact: true }).click();
    await expect(dlg.locator('ul.list li', { hasText: 'RSS Feed' })).toHaveCount(1);
  });
});

test.describe('view header layout', () => {
  test('the filter/search control sits at the very right of the view header', async ({ page }) => {
    const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ title: 'Alpha', url: 'https://example.com/a' }]);

    await page
      .locator(`#${panelDomId(id)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const bar = page.locator('[id^="view-panel-"].jsPanel .jsPanel-controlbar');
    await expect(bar.locator('panel-search')).toHaveCount(1);

    // Last child of the controlbar, which is itself the last thing in the
    // header — so it is the rightmost control there is, past Close.
    const lastIsSearch = await bar.evaluate((el) => el.lastElementChild?.tagName.toLowerCase() === 'panel-search');
    expect(lastIsSearch).toBe(true);

    // And visibly so: further right than the close button.
    const searchBox = (await bar.locator('panel-search').boundingBox())!;
    const closeBox = (await bar.locator('button[title="Close"]').boundingBox())!;
    expect(searchBox.x).toBeGreaterThan(closeBox.x);
  });

  test('a TABLE window keeps its search in front of the window buttons', async ({ page }) => {
    // Only views moved; the table header is deliberately unchanged.
    const id = await createTable(page, 'Plain', [{ field: 'a' }]);
    await waitForPanel(page, id);

    const bar = page.locator(`#${panelDomId(id)} .jsPanel-controlbar`);
    const searchBox = (await bar.locator('panel-search').boundingBox())!;
    const closeBox = (await bar.locator('button[title="Close"]').boundingBox())!;
    expect(searchBox.x).toBeLessThan(closeBox.x);
  });
});
