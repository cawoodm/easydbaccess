import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * The per-table free-text search supports boolean operators (uppercase AND/OR)
 * and, for a plain multi-word query, falls back phrase → AND → OR when the
 * earlier stage finds nothing.
 */
test.describe('boolean search', () => {
  async function open(page: import('@playwright/test').Page) {
    const id = await createTable(page, 'People', [{ field: 'name' }, { field: 'city' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [
      { name: 'Alice', city: 'Paris' },
      { name: 'Bob', city: 'London' },
      { name: 'Carol', city: 'Paris' },
    ]);
    const panel = page.locator(`#${panelDomId(id)}`);
    await expect(panel.locator('data-table tbody tr:visible')).toHaveCount(3);
    await panel.locator('panel-search').getByRole('button').click();
    const input = panel.locator('panel-search input');
    const rows = panel.locator('data-table tbody tr:visible');
    return { input, rows };
  }

  test('OR matches either term', async ({ page }) => {
    const { input, rows } = await open(page);
    await input.fill('Alice OR Bob');
    await expect(rows).toHaveCount(2);
  });

  test('AND matches both terms, across fields', async ({ page }) => {
    const { input, rows } = await open(page);
    // Alice is the only row that is both "alice" (name) AND "paris" (city).
    await input.fill('Alice AND Paris');
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('input').first()).toHaveValue('Alice');
  });

  test('plain multi-word falls back to AND when no phrase matches', async ({ page }) => {
    const { input, rows } = await open(page);
    // No field contains the phrase "carol paris", but Carol has both words →
    // AND fallback returns just Carol.
    await input.fill('Carol Paris');
    await expect(rows).toHaveCount(1);
    await expect(rows.locator('input').first()).toHaveValue('Carol');
  });

  test('plain multi-word falls back to OR when neither phrase nor AND match', async ({ page }) => {
    const { input, rows } = await open(page);
    // No "alice london" phrase, no row with both → OR: Alice (name) + Bob (city).
    await input.fill('Alice London');
    await expect(rows).toHaveCount(2);
  });
});
