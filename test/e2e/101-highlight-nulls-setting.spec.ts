import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The pink background on an empty cell is now a preference (Settings → Table
 * grid). It defaults to on, and turning it off repaints the grids that are
 * already open — there is no settings-changed live query, so `settings-events.ts`
 * is what carries the news.
 *
 * The red "does not fit this type" mark is deliberately NOT covered by the
 * switch: a gap is normal and can be called noise, a bad value cannot.
 */

const openSettings = async (page: import('@playwright/test').Page) => {
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('easydb:open-settings', { bubbles: true })));
  const dlg = page.locator('settings-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.getByRole('button', { name: 'Table grid' }).click();
  return dlg;
};

/**
 * The field's own switch (`label.bool`). The storage-layer control beside it is
 * a two-state pill (`.scope`) rather than a second tick box, because when both
 * were tick boxes in one row people read "user" as another on/off option — so
 * the two are now told apart by class as well as by eye.
 */
const nullSwitch = (dlg: import('@playwright/test').Locator) => dlg.locator('.field', { hasText: 'Highlight empty cells' }).locator('label.bool').locator('input');

test('the switch turns the pink off and on again while the table stays open', async ({ page }) => {
  // The bad value sits in a DATE column: a number column is REAL affinity, and
  // `sql-mapping.ts`'s `encodeValue` turns anything that will not parse into SQL
  // NULL — so `'12abc'` would come back as a second EMPTY cell rather than an
  // invalid one. A date is stored as text verbatim, so it survives to be marked.
  const id = await createTable(page, 'Mixed', [{ field: 'name' }, { field: 'due', type: 'date' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [
    { name: 'full', due: '2026-01-31' },
    { name: 'gaps', due: null },
    { name: 'bad', due: 'next tuesday' },
  ]);

  const table = page.locator(`#${panelDomId(id)} data-table`);
  await expect(table.locator('tbody tr:not(.spacer)')).toHaveCount(3);
  // On by default: one empty cell is pink, one bad value is red.
  await expect(table.locator('td.is-null')).toHaveCount(1);
  await expect(table.locator('td.is-invalid')).toHaveCount(1);

  const dlg = await openSettings(page);
  const toggle = nullSwitch(dlg);
  // On by default, and the dialog says so — a switch that reads "off" while the
  // pink is showing would take two clicks to turn off.
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  // Repainted with the dialog still open — no reload, no reopening the window.
  await expect(table.locator('td.is-null')).toHaveCount(0);
  // …and the invalid mark is untouched by this switch.
  await expect(table.locator('td.is-invalid')).toHaveCount(1);

  await toggle.check();
  await expect(table.locator('td.is-null')).toHaveCount(1);
});

test('the choice is remembered, and a table opened later respects it', async ({ page }) => {
  const first = await createTable(page, 'One', [{ field: 'a' }]);
  await waitForPanel(page, first);
  await bulkAddRows(page, first, [{ a: null }]);

  const dlg = await openSettings(page);
  await nullSwitch(dlg).uncheck();
  await dlg.getByRole('button', { name: 'Done', exact: true }).click();

  // A table created AFTER the change starts unhighlighted — the grid reads the
  // setting on mount, not only when the event fires.
  const second = await createTable(page, 'Two', [{ field: 'b' }]);
  await waitForPanel(page, second);
  await bulkAddRows(page, second, [{ b: null }]);
  await expect(page.locator(`#${panelDomId(second)} data-table tbody tr:not(.spacer)`)).toHaveCount(1);
  await expect(page.locator('data-table td.is-null')).toHaveCount(0);

  // And it survives a reload, because it is a stored workspace setting.
  await page.reload();
  await expect(page.locator(`#${panelDomId(second)} data-table tbody tr:not(.spacer)`)).toHaveCount(1);
  await expect(page.locator('data-table td.is-null')).toHaveCount(0);
});

test('moving it to this device only takes effect at once', async ({ page }) => {
  // The two layers can hold different values, so moving a key between them
  // CHANGES what a read resolves to. `toggleScope` wrote the new layer but never
  // announced it, so every open grid went on showing the workspace answer until
  // a reload — which is indistinguishable from "the user layer does nothing".
  const id = await createTable(page, 'Layered', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ a: null }]);
  const table = page.locator(`#${panelDomId(id)} data-table`);
  await expect(table.locator('td.is-null')).toHaveCount(1);

  const dlg = await openSettings(page);
  const field = dlg.locator('.field', { hasText: 'Highlight empty cells' });
  // Put "off" on the workspace layer, then move the key to this device.
  await nullSwitch(dlg).uncheck();
  await expect(table.locator('td.is-null')).toHaveCount(0);
  await field.locator('.scope label', { hasText: 'This device' }).click();
  // Still off — the value travelled with the key — and now the switch repaints
  // from the user layer, with no reload in between.
  await expect(table.locator('td.is-null')).toHaveCount(0);
  await nullSwitch(dlg).check();
  await expect(table.locator('td.is-null')).toHaveCount(1);
});

test('a value on the user layer wins over the workspace one', async ({ page }) => {
  // The user layer is device-local and shadows the workspace layer at read time.
  // Written straight to localStorage here, which is what an earlier session (or
  // another workspace) leaves behind — the case the dialog cannot set up alone,
  // because moving a key between layers takes its value with it.
  const id = await createTable(page, 'Shadowed', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ a: null }]);
  await expect(page.locator(`#${panelDomId(id)} data-table td.is-null`)).toHaveCount(1);

  await page.evaluate(() => {
    // The workspace says highlight; this device says do not.
    localStorage.setItem('/easydbaccess/settings.json', JSON.stringify({ 'grid:highlightNulls': false }));
  });
  await page.reload();
  await expect(page.locator(`#${panelDomId(id)} data-table tbody tr:not(.spacer)`)).toHaveCount(1);
  await expect(page.locator(`#${panelDomId(id)} data-table td.is-null`)).toHaveCount(0);

  // And the Settings dialog shows it as the device-local value, not the
  // workspace default — so what it reads back is what is in force.
  const dlg = await openSettings(page);
  await expect(nullSwitch(dlg)).not.toBeChecked();
  await expect(dlg.locator('.field', { hasText: 'Highlight empty cells' }).locator('.scope label.on')).toHaveText('This device');
});

test('the switch still repaints once the key lives on the user layer', async ({ page }) => {
  // The reported symptom was "setting it at the user level has no effect". The
  // resolver has always preferred the user layer (see the test above), so what
  // is pinned here is the other half: after MOVING the key to this device, the
  // ordinary on/off switch must still repaint the open grids.
  const id = await createTable(page, 'Device', [{ field: 'a' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ a: null }]);
  const table = page.locator(`#${panelDomId(id)} data-table`);
  await expect(table.locator('td.is-null')).toHaveCount(1);

  const dlg = await openSettings(page);
  await dlg.locator('.field', { hasText: 'Highlight empty cells' }).locator('.scope label', { hasText: 'This device' }).click();
  await nullSwitch(dlg).uncheck();
  await expect(table.locator('td.is-null')).toHaveCount(0);
  await nullSwitch(dlg).check();
  await expect(table.locator('td.is-null')).toHaveCount(1);

  // And it really is device-local now: nothing was left in the workspace.
  const stored = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    return (await ctx.store.settings.findOne('grid:highlightNulls')) ?? null;
  });
  expect(stored).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('/easydbaccess/settings.json') ?? '{}')['grid:highlightNulls'])).toBe(true);
});

test('the storage control is a two-state pill, not a second on/off box', async ({ page }) => {
  // It used to be a tick box labelled "user", in the same row as the boolean
  // tick box and looking identical — so people read it as another option to
  // enable, and set it expecting the feature to change. A pill cannot be read
  // that way: both answers are on screen, one is always chosen, and neither is
  // spelled as on or off.
  const dlg = await openSettings(page);
  const field = dlg.locator('.field', { hasText: 'Highlight empty cells' });

  // Exactly one tick box in the row, and it is the setting's own value.
  await expect(field.locator('input[type="checkbox"]')).toHaveCount(1);
  await expect(field.locator('label.bool')).toHaveText(/enabled/);

  const pill = field.locator('.scope');
  await expect(pill.locator('label')).toHaveText(['Workspace', 'This device']);
  await expect(pill.locator('label.on')).toHaveText('Workspace');

  await pill.locator('label', { hasText: 'This device' }).click();
  await expect(pill.locator('label.on')).toHaveText('This device');
  await pill.locator('label', { hasText: 'Workspace' }).click();
  await expect(pill.locator('label.on')).toHaveText('Workspace');
});
