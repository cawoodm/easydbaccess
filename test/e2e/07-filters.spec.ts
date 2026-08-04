import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * TODO § Filters
 * - per-column filter dropdown with unique-value picker (capped at 500)
 * - funnel icon active state (blue) when the column has an active filter
 * - faceted options: dropdown values respect OTHER columns' filters
 * - filter dropdown anchored under the header, escapes panel clip (body portal)
 */

test.describe('filters', () => {
  test('funnel icon opens the picker with unique values', async ({ page }) => {
    const id = await createTable(page, 'Pets', [{ field: 'species' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { species: 'cat' });
    await addRow(page, id, { species: 'dog' });
    await addRow(page, id, { species: 'cat' });
    await addRow(page, id, { species: 'fish' });

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('data-table thead th button.funnel').first().click();

    const popover = page.locator('filter-popover');
    await expect(popover).toBeVisible();
    // Unique values: cat (2), dog (1), fish (1) — count next to label.
    await expect(popover.locator('li')).toHaveCount(3);
    await expect(popover.locator('li').filter({ hasText: 'cat' })).toContainText('2');
  });

  test('a boolean column always offers both true and false', async ({ page }) => {
    // Every row is true, so "false" is absent from the data — the dropdown must
    // still offer it (at count 0) or there is no way to filter for it.
    const id = await createTable(page, 'Tasks', [{ field: 'name' }, { field: 'done', type: 'boolean' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'a', done: true });
    await addRow(page, id, { name: 'b', done: true });

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('data-table thead th button.funnel').nth(1).click();

    const popover = page.locator('filter-popover');
    await expect(popover).toBeVisible();
    const items = popover.locator('li');
    await expect(items).toHaveCount(2);
    // true first (count 2), then false at 0.
    await expect(items.nth(0)).toContainText('true');
    await expect(items.nth(0)).toContainText('2');
    await expect(items.nth(1)).toContainText('false');
    await expect(items.nth(1)).toContainText('0');
  });

  test('picking a value filters the table and lights the funnel', async ({ page }) => {
    const id = await createTable(page, 'Pets', [{ field: 'species' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { species: 'cat' });
    await addRow(page, id, { species: 'dog' });
    await addRow(page, id, { species: 'cat' });

    const panel = page.locator(`#${panelDomId(id)}`);
    const funnel = panel.locator('data-table thead th button.funnel').first();
    await funnel.click();

    const popover = page.locator('filter-popover');
    await popover.locator('li').filter({ hasText: 'cat' }).click();

    // Only matching rows remain visible.
    await expect(panel.locator('data-table tbody tr:not(.spacer):visible')).toHaveCount(2);
    // Funnel goes "active" — class string contains 'active'.
    await expect(funnel).toHaveClass(/active/);

    // Clear filter via the popover returns all rows.
    await funnel.click();
    await popover.getByRole('button', { name: 'Clear filter' }).click();
    await expect(panel.locator('data-table tbody tr:not(.spacer):visible')).toHaveCount(3);
    await expect(funnel).not.toHaveClass(/active/);
  });

  test('faceted: country filter narrows the city dropdown', async ({ page }) => {
    const id = await createTable(page, 'Cities', [{ field: 'country' }, { field: 'city' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { country: 'Sweden', city: 'Stockholm' });
    await addRow(page, id, { country: 'Sweden', city: 'Gothenburg' });
    await addRow(page, id, { country: 'Norway', city: 'Oslo' });
    await addRow(page, id, { country: 'Norway', city: 'Bergen' });

    const panel = page.locator(`#${panelDomId(id)}`);
    // Filter country=Sweden via the picker.
    await panel.locator('data-table thead th button.funnel').nth(0).click();
    const popover = page.locator('filter-popover');
    await popover.locator('li').filter({ hasText: 'Sweden' }).click();
    // The picker is multi-select, so it STAYS OPEN after a toggle — dismiss it
    // by clicking away before opening the next column's picker.
    await expect(popover.locator('li').filter({ hasText: 'Sweden' }).locator('.cb.on')).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(popover).toBeHidden();

    // Now open the city picker — it should only list Stockholm + Gothenburg.
    await panel.locator('data-table thead th button.funnel').nth(1).click();
    await expect(popover).toBeVisible();
    await expect(popover.locator('li')).toHaveCount(2);
    await expect(popover.locator('li').first()).toContainText(/Stockholm|Gothenburg/);
    await expect(popover.locator('li').nth(1)).toContainText(/Stockholm|Gothenburg/);
  });

  test('tri-state: values cycle off → include → exclude, several at once', async ({ page }) => {
    const id = await createTable(page, 'Nordics', [{ field: 'country' }]);
    await waitForPanel(page, id);
    for (const country of ['Sweden', 'Norway', 'Denmark', 'Iceland']) {
      await addRow(page, id, { country });
    }

    const panel = page.locator(`#${panelDomId(id)}`);
    const rows = panel.locator('data-table tbody tr:not(.spacer):visible');
    await panel.locator('data-table thead th button.funnel').first().click();
    const popover = page.locator('filter-popover');
    const row = (name: string) => popover.locator('li').filter({ hasText: name });

    // First click includes (green ✓); the popover stays open for the next pick.
    await row('Sweden').click();
    await expect(row('Sweden').locator('.cb.on')).toBeVisible();
    await expect(rows).toHaveCount(1);

    // A second included value is a UNION, not a narrowing.
    await row('Norway').click();
    await expect(rows).toHaveCount(2);

    // Second click on the same value excludes it (red ✕): Sweden drops out and
    // only Norway is left included.
    await row('Sweden').click();
    await expect(row('Sweden').locator('.cb.not')).toBeVisible();
    await expect(rows).toHaveCount(1);

    // Third click clears that value: Norway alone stays included.
    await row('Sweden').click();
    await expect(row('Sweden').locator('.cb.on')).toHaveCount(0);
    await expect(row('Sweden').locator('.cb.not')).toHaveCount(0);
    await expect(rows).toHaveCount(1);
  });

  test('typed filters: ^ anchors to the start and shows no empty dropdown', async ({ page }) => {
    const id = await createTable(page, 'Anchored', [{ field: 'country' }]);
    await waitForPanel(page, id);
    for (const country of ['Sweden', 'Spain', 'Austria']) {
      await addRow(page, id, { country });
    }

    const panel = page.locator(`#${panelDomId(id)}`);
    const rows = panel.locator('data-table tbody tr:not(.spacer):visible');
    const input = panel.locator('data-table tr.filter-row filter-combobox input').first();

    // Substring match finds "Austria" via its inner "t".
    await input.fill('t');
    await expect(rows).toHaveCount(1);
    // Anchored to the start, nothing begins with "t".
    await input.fill('^t');
    await expect(rows).toHaveCount(0);
    // ^S keeps only the two that start with S.
    await input.fill('^S');
    await expect(rows).toHaveCount(2);
    // A term matching no raw value must NOT render an obstructing dropdown.
    const dropdown = panel.locator('data-table tr.filter-row filter-combobox ul.dropdown');
    await expect(dropdown).toHaveCount(0);

    // A matching term shows it again — and losing focus dismisses it.
    await input.fill('S');
    await expect(dropdown).toBeVisible();
    await input.blur();
    await expect(dropdown).toHaveCount(0);
  });

  test('typed filters: AND requires both conditions on one column', async ({ page }) => {
    // A comma ORs, so two conditions on one column had no spelling. `!NULL AND
    // Biden` used to parse as one negated token whose term was the literal text
    // "NULL AND Biden": it matched nothing, excluded nothing, and every row
    // stayed on screen.
    const id = await createTable(page, 'Candidates', [{ field: 'headline' }]);
    await waitForPanel(page, id);
    for (const headline of ['Biden wins', 'Trump wins', '']) {
      await addRow(page, id, { headline });
    }

    const panel = page.locator(`#${panelDomId(id)}`);
    const rows = panel.locator('data-table tbody tr:not(.spacer):visible');
    const input = panel.locator('data-table tr.filter-row filter-combobox input').first();

    await input.fill('!NULL AND Biden');
    await expect(rows).toHaveCount(1);
    // A plain string cell renders an editable input, so the text is its value.
    await expect(rows.first().locator('td input').first()).toHaveValue('Biden wins');

    // AND binds tighter than the comma: (Biden AND wins) OR Trump.
    await input.fill('Biden AND wins,Trump');
    await expect(rows).toHaveCount(2);

    // OR is a spelled-out comma.
    await input.fill('Biden OR Trump');
    await expect(rows).toHaveCount(2);

    // Lowercase is a word, not an operator, so nothing contains this phrase.
    await input.fill('Biden and Trump');
    await expect(rows).toHaveCount(0);
  });

  test('popover is portal-mounted (fixed positioning, escapes panel clip)', async ({ page }) => {
    const id = await createTable(page, 'Anchor', [{ field: 'a' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { a: 'x' });

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel.locator('data-table thead th button.funnel').first().click();

    const popover = page.locator('filter-popover');
    await expect(popover).toBeVisible();

    // Popover lives directly under document.body (or at index.html root),
    // not inside the panel — that's how it escapes overflow:auto clipping.
    const parent = await popover.evaluate((el) => el.parentElement?.tagName.toLowerCase());
    expect(parent).toBe('body');

    // And the computed position is `fixed`, the actual mechanism that
    // makes it ignore ancestor overflow regions.
    const pos = await popover.evaluate((el) => getComputedStyle(el).position);
    expect(pos).toBe('fixed');
  });
});
