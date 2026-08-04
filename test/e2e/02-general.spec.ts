import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * TODO § General
 * - z-order of windows persisted with geometry
 * - create new workspace (the `+` button in workspace-selector)
 * - per-table local search (panel-search expands from icon)
 * - jsPanel footer with action buttons (panel-footer)
 */

test.describe('general', () => {
  test('z-order persists across reload (last-fronted wins)', async ({ page, workspaceId }) => {
    const idA = await createTable(page, 'Alpha', [{ field: 'name' }]);
    await waitForPanel(page, idA);
    const idB = await createTable(page, 'Bravo', [{ field: 'name' }]);
    await waitForPanel(page, idB);

    // Bring panel A to front. jsPanel's onfronted handler stamps Date.now()
    // into windowGeometry.z so the boot-time sort puts A on top next reload.
    // Call .front() programmatically so we don't depend on which header DOM
    // element is clickable (jsPanel's chrome varies by theme/version).
    await page.evaluate((id) => {
      const el = document.getElementById(id) as HTMLElement & { front?: () => void };
      el?.front?.();
    }, panelDomId(idA));
    // Geometry write is async — wait until A's z is greater than B's.
    await expect
      .poll(async () => {
        const [a, b] = await Promise.all([readTable(page, idA), readTable(page, idB)]);
        return (a?.windowGeometry?.z ?? 0) > (b?.windowGeometry?.z ?? 0);
      })
      .toBe(true);

    await page.reload();
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    await waitForPanel(page, idA);
    await waitForPanel(page, idB);

    // Compare CSS z-index of the two panels. The later-fronted panel (A) must
    // sit above B after the rehydrated open order.
    const stack = await page.evaluate(
      ({ a, b }) => {
        const za = Number(getComputedStyle(document.getElementById(a)!).zIndex) || 0;
        const zb = Number(getComputedStyle(document.getElementById(b)!).zIndex) || 0;
        return { za, zb };
      },
      { a: panelDomId(idA), b: panelDomId(idB) },
    );
    expect(stack.za).toBeGreaterThan(stack.zb);

    // Reference workspaceId so it's not flagged as unused — the fixture
    // guarantees an isolated DB for this test.
    expect(workspaceId).toBeTruthy();
  });

  test('+ button creates a new workspace and switches to it', async ({ page }) => {
    const dialog = page.locator('host-dialogs');
    const newName = `ws-${Math.random().toString(36).slice(2, 8)}`;

    await page.locator('workspace-selector').getByTitle('New workspace').click();
    const input = dialog.locator('input[type="text"]').first();
    await input.waitFor();
    await input.fill(newName);
    await dialog.getByRole('button', { name: 'OK', exact: true }).click();
    // Second step: what the new workspace starts with (see 51-workspace-clone
    // for what each answer copies). This test only cares that it switches.
    await dialog.getByRole('button', { name: /Empty workspace/ }).click();

    // Selector switches by location.assign — wait for the navigation and
    // re-establish the __easydb hook (the URL keeps ?test=1 in the query).
    await page.waitForURL((u) => u.searchParams.get('space') === newName);
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );

    const wsId = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.workspaceId,
    );
    expect(wsId).toBe(newName);

    // The new workspace exists in the store, with the typed name.
    const ws = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (id) => (window as any).__easydb.store.workspaces.findOne(id),
      newName,
    );
    expect(ws?.name).toBe(newName);
  });

  test('opening the app without ?space restores the last-active workspace', async ({ page, workspaceId }) => {
    // The fixture booted workspace A (its id "e2e-…" sorts before "zzz-last").
    const idA = await createTable(page, 'AlphaOnly', [{ field: 'a' }]);
    await waitForPanel(page, idA);
    expect(workspaceId).toBeTruthy();

    // Switch to a second workspace whose id sorts AFTER A, and add a table.
    await page.goto('/?test=1&space=zzz-last');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );
    const idB = await createTable(page, 'BetaOnly', [{ field: 'b' }]);
    await waitForPanel(page, idB);

    // Open the bare URL — like a new tab or a bookmark with no ?space=.
    await page.goto('/?test=1');
    await page.waitForFunction(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => Boolean((window as any).__easydb),
    );

    // It restores the last-active workspace ("zzz-last"), not the first one, so
    // the data the user was looking at is still there.
    const activeWs = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => (window as any).__easydb.workspaceId,
    );
    expect(activeWs).toBe('zzz-last');
    await waitForPanel(page, idB);
  });

  test('per-table search filters rows in its panel', async ({ page }) => {
    const id = await createTable(page, 'People', [{ field: 'name', renderer: 'link' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice' });
    await addRow(page, id, { name: 'Bob' });
    await addRow(page, id, { name: 'Carol' });

    const panel = page.locator(`#${panelDomId(id)}`);
    // Wait for the data-table to render three rows.
    await expect(panel.locator('data-table').locator('tbody tr')).toHaveCount(3);

    // Expand the panel-search input and type a query.
    await panel.locator('panel-search').getByRole('button').click();
    const searchInput = panel.locator('panel-search input');
    await searchInput.fill('bob');

    // Only the matching row remains visible. (Cell values are rendered as
    // <input value="…"> not text nodes, so we assert via the input's value.)
    await expect(panel.locator('data-table').locator('tbody tr:visible')).toHaveCount(1);
    await expect(panel.locator('data-table').locator('tbody tr:visible input').first()).toHaveValue('Bob');

    // Clear → all rows return.
    await searchInput.fill('');
    await expect(panel.locator('data-table').locator('tbody tr:visible')).toHaveCount(3);
  });

  test('per-table search focuses the input on open and collapses on click-outside', async ({ page }) => {
    const id = await createTable(page, 'Focusable', [{ field: 'name' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const search = panel.locator('panel-search');

    // Open the search: the freshly-rendered input must be focused (autofocus
    // is unreliable for dynamically-inserted inputs, so the component focuses
    // it explicitly).
    await search.getByRole('button').click();
    const input = search.locator('input');
    await expect(input).toBeFocused();

    // Type a query, then click elsewhere (a cell in the table). The box blurs
    // and collapses back to the icon; the active filter is preserved so the
    // icon reports it via its title.
    await input.fill('alice');
    await panel.locator('data-table tbody tr:visible input').first().click();
    await expect(search.locator('input')).toHaveCount(0);
    await expect(search.getByRole('button')).toHaveAttribute('title', /Filtering rows: alice/);

    // Re-opening shows the preserved query, focused and ready to edit.
    await search.getByRole('button').click();
    await expect(search.locator('input')).toBeFocused();
    await expect(search.locator('input')).toHaveValue('alice');
  });

  test('panel footer exposes Add row, Columns, and registered table buttons', async ({ page }) => {
    const id = await createTable(page, 'Inventory', [{ field: 'sku' }]);
    await waitForPanel(page, id);

    const footer = page.locator(`#${panelDomId(id)} panel-footer`);
    await expect(footer.getByRole('button', { name: /Add row/ })).toBeVisible();
    await expect(footer.getByRole('button', { name: /Columns/ })).toBeVisible();
    // dump-export plugin registers an "Export" table button (CSV/JSON/SQL
    // menu) — confirms the registry → footer path works. Footer buttons are
    // icon-only, so the accessible name comes from aria-label (set to the
    // button's label).
    await expect(footer.getByRole('button', { name: /Export/ })).toBeVisible();

    // Icon-only: the button shows just its icon glyph (ligature text "add"),
    // not the "Add row" text label (which now lives on aria-label/title).
    const addText = await footer.getByRole('button', { name: /Add row/ }).innerText();
    expect(addText.toLowerCase()).not.toContain('row');

    // Row count starts at 0 → "0 rows", then "Add row" makes it 1.
    await expect(footer).toContainText('0 rows');
    await footer.getByRole('button', { name: /Add row/ }).click();
    await expect(footer).toContainText('1 row');
  });
});
