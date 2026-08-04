import { test, expect } from './fixtures.js';
import { addRow, createTable, panelDomId, readTable, waitForPanel } from './helpers.js';

/**
 * TODO § Columns Editor
 * - drag-to-reorder columns by dragging the `th` itself
 * - hide/show columns (`Column.hidden` flag + eye toggle)
 * - max length input in editor
 */

test.describe('columns editor', () => {
  test('drag-to-reorder columns reorders the table', async ({ page }) => {
    const id = await createTable(page, 'Two', [{ field: 'a' }, { field: 'b' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { a: '1', b: '2' });

    const before = (await readTable(page, id))?.columns.map((c: { field: string }) => c.field);
    expect(before).toEqual(['a', 'b']);

    // Native HTML5 drag — dispatch dragstart on b, dragover (right half) and
    // drop on a. The handler reads e.clientX vs th.getBoundingClientRect()
    // to decide before/after; we pass clientX < midpoint → "before",
    // so 'b' lands before 'a'.
    await page.evaluate((domId) => {
      const panel = document.getElementById(domId)!;
      const dt = panel.querySelector('data-table') as HTMLElement & { shadowRoot: ShadowRoot };
      const ths = dt.shadowRoot.querySelectorAll('thead th');
      const aTh = ths[0] as HTMLElement;
      const bTh = ths[1] as HTMLElement;
      const dataTransfer = new DataTransfer();
      const aRect = aTh.getBoundingClientRect();
      const beforeX = aRect.left + aRect.width / 4;
      const midY = aRect.top + aRect.height / 2;

      // Reorder now starts from the small `.col-grip` handle, not the th.
      const bGrip = bTh.querySelector('.col-grip') as HTMLElement;
      bGrip.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }));
      aTh.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: beforeX,
          clientY: midY,
        }),
      );
      aTh.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientX: beforeX,
          clientY: midY,
        }),
      );
      bGrip.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));
    }, panelDomId(id));

    // The drop handler persists asynchronously — poll until columns flipped.
    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns.map((c: { field: string }) => c.field).join(',');
      })
      .toBe('b,a');
  });

  test('hide column via editor removes it from the data-table', async ({ page }) => {
    const id = await createTable(page, 'Visibility', [{ field: 'keep' }, { field: 'hideme' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { keep: 'k', hideme: 'h' });

    const panel = page.locator(`#${panelDomId(id)}`);
    // thead has two rows (column-header + filter-row) and a trailing delete
    // column, so per-column counts go through the header row only and skip
    // the delete-column th. Easier: assert the column LABEL is present.
    await expect(panel.locator('data-table thead')).toContainText('hideme');

    // Open the column editor via the panel-footer Columns button.
    await panel
      .locator('panel-footer')
      .getByRole('button', { name: /Columns/ })
      .click();

    const dialog = page.locator('new-table-dialog dialog');
    await expect(dialog).toBeVisible();

    // Uncheck the "visible" checkbox for the second column (index 1).
    // Selected by title, not position: the visible box is the FIRST control in
    // each row now (its header toggles the whole column), and it has moved before.
    const colRows = dialog.locator('.col-row');
    await expect(colRows).toHaveCount(2);
    const secondRowVisible = colRows.nth(1).locator('input[title^="Visible"]');
    await secondRowVisible.uncheck();

    // Submit.
    await dialog.getByRole('button', { name: /Save|Create/ }).click();
    await expect(dialog).toBeHidden();

    // Persisted: column[1].hidden === true.
    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns[1]?.hidden;
      })
      .toBe(true);

    // Rendered: the hidden column's label is gone from the header.
    await expect(panel.locator('data-table thead')).not.toContainText('hideme');
    await expect(panel.locator('data-table thead')).toContainText('keep');
  });

  test('clicking the visible header hides every column, clicking again shows them', async ({ page }) => {
    // The point of the header toggle: on a wide table, hiding all but a few
    // columns one checkbox at a time is the tedium it exists to remove.
    const id = await createTable(page, 'AllOrNone', [{ field: 'a' }, { field: 'b' }, { field: 'c' }]);
    await waitForPanel(page, id);

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel
      .locator('panel-footer')
      .getByRole('button', { name: /Columns/ })
      .click();
    const dialog = page.locator('new-table-dialog dialog');
    await expect(dialog).toBeVisible();

    // All three start visible, so the first click clears them.
    const head = dialog.locator('.col-header button.flag-head[title^="Visible"]');
    await head.click();
    for (const box of await dialog.locator('.col-row input[title^="Visible"]').all()) {
      await expect(box).not.toBeChecked();
    }

    // And the second click puts them all back.
    await head.click();
    for (const box of await dialog.locator('.col-row input[title^="Visible"]').all()) {
      await expect(box).toBeChecked();
    }

    // One off, then a click: mixed means "select all", so nothing stays hidden.
    await dialog.locator('.col-row').nth(1).locator('input[title^="Visible"]').uncheck();
    await head.click();
    for (const box of await dialog.locator('.col-row input[title^="Visible"]').all()) {
      await expect(box).toBeChecked();
    }

    // Hide them all for real and check it SAVES — the toggle writes the draft,
    // and `hidden` is stored inverted, so a working UI can still persist nothing.
    await head.click();
    await dialog.getByRole('button', { name: /Save|Create/ }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns.map((c: { hidden?: boolean }) => c.hidden === true).join(',');
      })
      .toBe('true,true,true');
  });

  test('max length input persists Column.max', async ({ page }) => {
    const id = await createTable(page, 'Limits', [{ field: 'code' }]);
    await waitForPanel(page, id);

    const panel = page.locator(`#${panelDomId(id)}`);
    await panel
      .locator('panel-footer')
      .getByRole('button', { name: /Columns/ })
      .click();

    const dialog = page.locator('new-table-dialog dialog');
    await expect(dialog).toBeVisible();

    // The max input is the type=number input in the first column row.
    const maxInput = dialog.locator('.col-row').first().locator('input[type="number"]');
    await maxInput.fill('42');
    await dialog.getByRole('button', { name: /Save|Create/ }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () => {
        const t = await readTable(page, id);
        return t?.columns[0]?.max;
      })
      .toBe(42);
  });
});
