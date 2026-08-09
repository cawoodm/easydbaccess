import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A view token can carry its own `render(row)` script, so the view formats what
 * it shows — markdown as HTML, a date the way a reader wants it — while the
 * stored cell keeps the raw value the table needs.
 */
test.describe('view token scripts', () => {
  /** Opens the Views manager for a table and returns its dialog locator. */
  async function openViews(page: import('@playwright/test').Page, tableId: string) {
    await page
      .locator(`#${panelDomId(tableId)} panel-footer`)
      .getByRole('button', { name: /Views/ })
      .click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    return dlg;
  }

  /** A template whose row fragment renders the two tokens in their own elements. */
  async function makeTemplate(page: import('@playwright/test').Page, dlg: ReturnType<import('@playwright/test').Page['locator']>) {
    await dlg.getByRole('button', { name: '+ New template' }).click();
    await dlg.locator('input[type="text"]').fill('Boxes');
    const areas = dlg.locator('textarea');
    await areas.nth(1).fill('<div class="card"><div class="body">$BODY</div><span class="when">$WHEN</span></div>');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.locator('ul.list li', { hasText: 'Boxes' }).getByRole('button', { name: 'Use' }).click();
  }

  test('the ƒ(x) button scripts one token, and only that token is formatted', async ({ page }) => {
    const id = await createTable(page, 'Posts', [{ field: 'body' }, { field: 'when' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: '# Hello', when: '2026-06-17T10:59:56.937Z' }]);

    const dlg = await openViews(page, id);
    await makeTemplate(page, dlg);

    // The script editor opens per token, pre-filled with the mapped field — the
    // transform wanted is nearly always "that cell, formatted".
    const bodyRow = dlg.locator('.map-row', { hasText: '$BODY' });
    await bodyRow.getByRole('button', { name: 'ƒ(x)' }).click();
    const editor = page.locator('script-editor-dialog');
    await expect(editor.locator('.dialog-header h2')).toContainText('$BODY');
    await expect(editor.locator('textarea')).toHaveValue(/row\.body/);
    await editor.locator('textarea').fill('function render(row) { return markdownToHtml(row.body); }');
    await editor.getByRole('button', { name: 'Save' }).click();

    // The button says the token is scripted — the script itself lives in a modal.
    await expect(bodyRow.getByRole('button', { name: 'ƒ(x)' })).toHaveClass(/scripted/);

    await dlg.getByRole('button', { name: 'Create view' }).click();

    // $BODY renders the script's HTML; $WHEN, unscripted, still shows the raw cell.
    const vw = page.locator('view-window');
    await expect(vw.locator('.body h1')).toHaveText('Hello');
    await expect(vw.locator('.when')).toHaveText('2026-06-17T10:59:56.937Z');

    // And the stored row is untouched — the view formats, it does not write.
    const stored = await page.evaluate(async (tid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = await (window as any).__easydb.store.rows(tid).find();
      return rows[0].data.body;
    }, id);
    expect(stored).toBe('# Hello');
  });

  test('a script added while the view is open applies at once, and clearing it goes back to the raw value', async ({ page, workspaceId }) => {
    const id = await createTable(page, 'Posts', [{ field: 'body' }, { field: 'when' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'plain', when: '2026-06-17T10:59:56.937Z' }]);

    const dlg = await openViews(page, id);
    await makeTemplate(page, dlg);
    await dlg.getByRole('button', { name: 'Create view' }).click();

    const vw = page.locator('view-window');
    await expect(vw.locator('.when')).toHaveText('2026-06-17T10:59:56.937Z');

    // Script $WHEN from the view's own "Edit view" icon.
    await vw.getByRole('button', { name: 'Edit view' }).click();
    const whenRow = dlg.locator('.map-row', { hasText: '$WHEN' });
    await whenRow.getByRole('button', { name: 'ƒ(x)' }).click();
    const editor = page.locator('script-editor-dialog');
    await editor.locator('textarea').fill('function render(row) { return new Date(row.when).getUTCFullYear(); }');
    await editor.getByRole('button', { name: 'Save' }).click();
    await dlg.getByRole('button', { name: 'Save' }).click();
    // Saving an edit returns to the list, it does not close the manager — and a
    // modal dialog swallows the clicks the rest of this test needs.
    await dlg.getByRole('button', { name: 'Close' }).click();

    // The open window re-renders with the formatted value.
    await expect(vw.locator('.when')).toHaveText('2026');
    const scripts = await page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      return (await store.viewInstances.find({ workspaceId: ws }))[0]?.tokenScripts ?? null;
    }, workspaceId);
    expect(Object.keys(scripts ?? {})).toEqual(['WHEN']);

    // Emptying the editor drops the script, and the token shows the cell again.
    await vw.getByRole('button', { name: 'Edit view' }).click();
    await expect(dlg.locator('.map-row', { hasText: '$WHEN' }).getByRole('button', { name: 'ƒ(x)' })).toHaveClass(/scripted/);
    await dlg.locator('.map-row', { hasText: '$WHEN' }).getByRole('button', { name: 'ƒ(x)' }).click();
    await editor.locator('textarea').fill('');
    await editor.getByRole('button', { name: 'Save' }).click();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await dlg.getByRole('button', { name: 'Close' }).click();
    await expect(vw.locator('.when')).toHaveText('2026-06-17T10:59:56.937Z');
  });

  test('a scripted token needs no column, and a $filter. pill keeps the stored value', async ({ page, workspaceId }) => {
    const id = await createTable(page, 'Posts', [{ field: 'tag' }, { field: 'n', type: 'number' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ tag: 'red', n: 3 }]);

    // Straight through the store: $SUM maps to nothing and computes from the row;
    // $filter.TAG carries a script that must be IGNORED, because the pill's text
    // has to equal the stored value or the click matches no row.
    await page.evaluate(
      async ({ ws, tid }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const tpl = crypto.randomUUID();
        await store.viewTemplates.insert({
          id: tpl,
          workspaceId: ws,
          name: 'Scripted',
          headerHtml: '<div>',
          rowHtml: '<p class="sum">$SUM</p>$filter.TAG',
          footerHtml: '</div>',
          updatedAt: Date.now(),
        });
        await store.viewInstances.insert({
          id: crypto.randomUUID(),
          workspaceId: ws,
          tableId: tid,
          templateId: tpl,
          name: 'Scripted',
          filters: {},
          visibleColumns: ['tag', 'n'],
          mapping: { TAG: 'tag' },
          tokenScripts: {
            SUM: 'function render(row) { return row.n * 2; }',
            TAG: 'function render() { return "SHOUTED"; }',
          },
          open: true,
          updatedAt: Date.now(),
        });
      },
      { ws: workspaceId, tid: id },
    );

    const vw = page.locator('view-window');
    await expect(vw.locator('.sum')).toHaveText('6');
    await expect(vw.locator('.eda-filter-pill')).toHaveText('red');
  });

  test('a broken script shows an error chip rather than an empty card', async ({ page, workspaceId }) => {
    const id = await createTable(page, 'Posts', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'text' }]);

    await page.evaluate(
      async ({ ws, tid }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const tpl = crypto.randomUUID();
        await store.viewTemplates.insert({
          id: tpl,
          workspaceId: ws,
          name: 'Broken',
          headerHtml: '<div>',
          rowHtml: '<p class="line">$BODY</p>',
          footerHtml: '</div>',
          updatedAt: Date.now(),
        });
        await store.viewInstances.insert({
          id: crypto.randomUUID(),
          workspaceId: ws,
          tableId: tid,
          templateId: tpl,
          name: 'Broken',
          filters: {},
          visibleColumns: ['body'],
          mapping: { BODY: 'body' },
          tokenScripts: { BODY: 'function render(row) { return boom(row); }' },
          open: true,
          updatedAt: Date.now(),
        });
      },
      { ws: workspaceId, tid: id },
    );

    const chip = page.locator('view-window .line .eda-script-error');
    await expect(chip).toHaveText('⚠ runtime error');
    await expect(chip).toHaveAttribute('title', /boom/);
  });
});
