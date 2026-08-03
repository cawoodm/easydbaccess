import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, readRows, waitForPanel } from './helpers.js';

/**
 * Four boolean stored-value states, per `util/cell-validity.ts`'s
 * `booleanState()`: a real `true`/`false` render the checkbox as usual; an
 * empty value (`null`) renders the SAME checkbox grayed out — still
 * clickable, so filling it in is just a click, which commits `true`; anything
 * else (`'foo'`) never renders a checkbox at all — it shows as red-bordered
 * raw text with a pencil so the bad value stays visible and fixable instead
 * of being silently coerced to unchecked.
 */
test.describe('cell-boolean four-state rendering', () => {
  test('true/false/empty/invalid render distinctly; empty is clickable; invalid is pencil-fixable', async ({
    page,
  }) => {
    const id = await createTable(page, 'Flags', [
      { field: 'flag', type: 'boolean', renderer: 'boolean' },
    ]);
    await waitForPanel(page, id);

    await bulkAddRows(page, id, [{ flag: true }, { flag: false }, { flag: null }, { flag: 'foo' }]);

    // Map each stored value to its DOM row index using the SAME query
    // (`store.rows(tableId).find()`) the component's own live query uses —
    // Dexie's result order is driven by the underlying index, not insertion
    // order, so this is how the test learns which <tr> holds which value
    // rather than assuming an order.
    const rows: Array<{ id: string; data: { flag: unknown } }> = await readRows(page, id);
    const idxOf = (pred: (v: unknown) => boolean) => rows.findIndex((r) => pred(r.data.flag));
    const trueIdx = idxOf((v) => v === true);
    const falseIdx = idxOf((v) => v === false);
    const emptyIdx = idxOf((v) => v === null);
    const invalidIdx = idxOf((v) => v === 'foo');
    expect([trueIdx, falseIdx, emptyIdx, invalidIdx].every((i) => i >= 0)).toBe(true);

    const panel = page.locator(`#${panelDomId(id)}`);
    const cellAt = (idx: number) =>
      panel.locator('data-table tbody tr').nth(idx).locator('cell-boolean');

    // true → checked checkbox, no "empty" grayed styling.
    const trueCheckbox = cellAt(trueIdx).locator('input[type="checkbox"]');
    await expect(trueCheckbox).toBeChecked();
    await expect(trueCheckbox).not.toHaveAttribute('style', /opacity/);

    // false → unchecked checkbox, no "empty" grayed styling either — a real
    // false must not look like an empty cell.
    const falseCheckbox = cellAt(falseIdx).locator('input[type="checkbox"]');
    await expect(falseCheckbox).not.toBeChecked();
    await expect(falseCheckbox).not.toHaveAttribute('style', /opacity/);

    // empty (null) → unchecked AND visibly grayed, with a title explaining why.
    const emptyCheckbox = cellAt(emptyIdx).locator('input[type="checkbox"]');
    await expect(emptyCheckbox).not.toBeChecked();
    await expect(emptyCheckbox).toHaveAttribute('style', /opacity/);
    await expect(emptyCheckbox).toHaveAttribute('title', /Empty/);

    // Clicking the empty checkbox commits true — an empty cell can be filled in.
    await emptyCheckbox.click();
    await expect(emptyCheckbox).toBeChecked();
    const emptyRowId = rows[emptyIdx]!.id;
    await expect
      .poll(async () => {
        const fresh = await readRows(page, id);
        return fresh.find((r: { id: string }) => r.id === emptyRowId)?.data.flag;
      })
      .toBe(true);

    // invalid ('foo') → no checkbox at all; red-bordered raw text + pencil.
    const invalidCell = cellAt(invalidIdx);
    await expect(invalidCell.locator('input[type="checkbox"]')).toHaveCount(0);
    const invalidText = invalidCell.locator('.cell-invalid');
    await expect(invalidText).toHaveText('foo');
    // #dc2626 == rgb(220, 38, 38) — the browser normalizes the inline style.
    await expect(invalidText).toHaveCSS('border-top-color', 'rgb(220, 38, 38)');
    const pencil = invalidCell.locator('.cell-pencil');
    await expect(pencil).toBeVisible();

    // The pencil reveals the raw stored value and lets it be corrected.
    await pencil.click();
    const editor = invalidCell.locator('input[type="text"]');
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue('foo');
    await editor.fill('true');
    await editor.blur();

    // Fixed: renders as a checked checkbox now, and the stored value updated.
    await expect(invalidCell.locator('input[type="checkbox"]')).toBeChecked();
    const invalidRowId = rows[invalidIdx]!.id;
    await expect
      .poll(async () => {
        const fresh = await readRows(page, id);
        return fresh.find((r: { id: string }) => r.id === invalidRowId)?.data.flag;
      })
      .toBe('true');
  });
});
