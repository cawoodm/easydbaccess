import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A `$TOKEN` shows what the GRID shows: the value through the mapped column's
 * own cell renderer. A view of a `link` column shows links and a `tags` column
 * shows pills, with the template saying nothing about it.
 *
 * The renderer is a custom element driven by properties, so `substituteRow`
 * leaves an empty slot and the view window mounts into it — which is why these
 * are e2e tests and not unit tests: the mount only happens in a real DOM.
 */

/** Installs a template whose row fragment is `rowHtml`, then makes a view of it. */
async function viewWith(page: import('@playwright/test').Page, ws: string, tableId: string, rowHtml: string, inst: Record<string, unknown> = {}) {
  await page.evaluate(
    async ({ ws, tableId, rowHtml, inst }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const tpl = crypto.randomUUID();
      await store.viewTemplates.insert({ id: tpl, workspaceId: ws, name: 'Cards', headerHtml: '<div>', rowHtml, footerHtml: '</div>', updatedAt: Date.now() });
      await store.viewInstances.insert({
        id: crypto.randomUUID(),
        workspaceId: ws,
        tableId,
        templateId: tpl,
        name: 'Cards',
        filters: {},
        visibleColumns: [],
        open: true,
        updatedAt: Date.now(),
        ...inst,
      });
    },
    { ws, tableId, rowHtml, inst },
  );
}

test('a link column renders as a link inside the card, not as bare URL text', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Links', [{ field: 'u', renderer: 'link' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ u: 'https://example.com/one' }]);
  await viewWith(page, workspaceId, id, '<p class="line">$URL</p>', { mapping: { URL: 'u' } });

  const vw = page.locator('view-window');
  // The renderer's own element is mounted into the slot the template left.
  await expect(vw.locator('.line .eda-cell cell-link')).toHaveCount(1);
  await expect(vw.locator('.line a')).toHaveAttribute('href', 'https://example.com/one');
});

test('an array column with the tags renderer shows pills', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Tagged', [{ field: 't', type: 'array', renderer: 'tags' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ t: 'red,blue' }]);
  await viewWith(page, workspaceId, id, '<p class="line">$TAGS</p>', { mapping: { TAGS: 't' } });

  const vw = page.locator('view-window');
  await expect(vw.locator('.line .eda-cell')).toHaveCount(1);
  // Two pills, not the string "red,blue".
  await expect(vw.locator('.line .eda-cell')).toContainText('red');
  await expect(vw.locator('.line .eda-cell')).toContainText('blue');
});

test('$raw.TOKEN skips the renderer and shows the stored text', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Links', [{ field: 'u', renderer: 'link' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ u: 'https://example.com/one' }]);
  await viewWith(page, workspaceId, id, '<p class="line">$raw.URL</p>', { mapping: { URL: 'u' } });

  const vw = page.locator('view-window');
  await expect(vw.locator('.line')).toHaveText('https://example.com/one');
  await expect(vw.locator('.line .eda-cell')).toHaveCount(0);
  await expect(vw.locator('.line a')).toHaveCount(0);
});

test('the per-token toggle turns the renderer off for a plain $TOKEN', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Links', [{ field: 'u', renderer: 'link' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ u: 'https://example.com/one' }]);
  await viewWith(page, workspaceId, id, '<p class="line">$URL</p>', { mapping: { URL: 'u' }, tokenRaw: { URL: true } });

  const vw = page.locator('view-window');
  await expect(vw.locator('.line')).toHaveText('https://example.com/one');
  await expect(vw.locator('.line .eda-cell')).toHaveCount(0);
});

test('a token inside a tag stays plain, so <img src="$IMAGE"> still works', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Shots', [{ field: 'img', renderer: 'image' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ img: 'https://pics.test/1.png' }]);
  await viewWith(page, workspaceId, id, '<img class="pic" src="$IMAGE">', { mapping: { IMAGE: 'img' } });

  // The value went into the attribute as text — an element there would have
  // produced a broken tag and no picture at all.
  await expect(page.locator('view-window img.pic')).toHaveAttribute('src', 'https://pics.test/1.png');
  await expect(page.locator('view-window .eda-cell')).toHaveCount(0);
});

test('the 🎨 / 🔤 toggle in the mapping dialog switches an open view', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Links', [{ field: 'u', renderer: 'link' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ u: 'https://example.com/one' }]);
  await viewWith(page, workspaceId, id, '<p class="line">$URL</p>', { mapping: { URL: 'u' } });

  const vw = page.locator('view-window');
  await expect(vw.locator('.line a')).toHaveCount(1);

  // Rendered is the default, so the button offers the plain value.
  await vw.getByRole('button', { name: 'Edit view' }).click();
  const dlg = page.locator('views-dialog dialog');
  const toggle = dlg.locator('.map-row', { hasText: '$URL' }).locator('button.mini').first();
  await expect(toggle).toHaveText('🎨');
  await toggle.click();
  await expect(toggle).toHaveText('🔤');
  await dlg.getByRole('button', { name: 'Save' }).click();
  // Deep-linked from "Edit view", so Save finishes and closes — no second click.
  await expect(dlg).toBeHidden();

  // The open view drops to plain text…
  await expect(vw.locator('.line')).toHaveText('https://example.com/one');
  await expect(vw.locator('.line a')).toHaveCount(0);
  const stored = await page.evaluate(async (ws) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__easydb.store;
    return (await store.viewInstances.find({ workspaceId: ws }))[0]?.tokenRaw ?? null;
  }, workspaceId);
  expect(stored).toEqual({ URL: true });

  // …and back again, with the flag dropped rather than left as false.
  await vw.getByRole('button', { name: 'Edit view' }).click();
  await dlg.locator('.map-row', { hasText: '$URL' }).locator('button.mini').first().click();
  await dlg.getByRole('button', { name: 'Save' }).click();
  // Deep-linked from "Edit view", so Save finishes and closes — no second click.
  await expect(dlg).toBeHidden();
  await expect(vw.locator('.line a')).toHaveCount(1);
});

test('a scripted token wins over the renderer — the script already decided', async ({ page, workspaceId }) => {
  const id = await createTable(page, 'Links', [{ field: 'u', renderer: 'link' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ u: 'https://example.com/one' }]);
  await viewWith(page, workspaceId, id, '<p class="line">$URL</p>', {
    mapping: { URL: 'u' },
    tokenScripts: { URL: 'function render(row) { return "just text"; }' },
  });

  const vw = page.locator('view-window');
  await expect(vw.locator('.line')).toHaveText('just text');
  await expect(vw.locator('.line .eda-cell')).toHaveCount(0);
});

test('the panel-footer Views dialog is where the default comes from — a fresh view renders', async ({ page }) => {
  const id = await createTable(page, 'Feed', [{ field: 'title' }, { field: 'url', renderer: 'link' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ title: 'Hello', url: 'https://example.com/1' }]);

  await page
    .locator(`#${panelDomId(id)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await dlg.locator('ul.list li', { hasText: 'RSS Feed' }).getByRole('button', { name: 'Use' }).click();
  // Every token starts rendered — the toggle shows 🎨 without anything stored.
  for (const tok of ['$TITLE', '$URL']) {
    await expect(dlg.locator('.map-row', { hasText: tok }).locator('button.mini').first()).toHaveText('🎨');
  }
  await dlg.getByRole('button', { name: 'Create view' }).click();

  // The RSS template wraps $TITLE in <a href="$URL">, so both stay plain: one is
  // inside a tag, and the other has no renderer on its column.
  const vw = page.locator('view-window');
  await expect(vw.locator('a', { hasText: 'Hello' })).toHaveAttribute('href', 'https://example.com/1');
});
