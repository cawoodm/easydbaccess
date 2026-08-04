import { test, expect } from './fixtures.js';
import { addRow, createTable, waitForPanel } from './helpers.js';

/**
 * sql-export specifics:
 * - `date` columns are emitted as 'YYYYMMDD' (CHAR(8))
 * - `datetime` columns keep their full ISO string under TIMESTAMP
 * - empty / unparseable date values become SQL NULL
 *
 * Drives the renderer to call serializeWorkspaceAsSql directly so we can
 * assert on the produced text without intercepting a download.
 */

test.describe('sql-export', () => {
  test('date columns serialize as YYYYMMDD CHAR(8); datetime stays ISO TIMESTAMP', async ({ page }) => {
    const id = await createTable(page, 'Visits', [{ field: 'name' }, { field: 'dob', type: 'date' }, { field: 'seen_at', type: 'datetime' }]);
    await waitForPanel(page, id);
    await addRow(page, id, { name: 'Alice', dob: '2026-05-24', seen_at: '2026-05-24T14:30' });
    await addRow(page, id, { name: 'Bob', dob: '', seen_at: null });
    // Bonus: longer ISO date string should still produce just the YMD prefix.
    await addRow(page, id, { name: 'Carol', dob: '1990-01-02T00:00:00.000Z', seen_at: null });

    const sql = await page.evaluate(async () => {
      const mod = await import('/src/plugins/sql-export.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return mod.serializeWorkspaceAsSql((window as any).__easydb.api);
    });

    // CREATE TABLE: date → CHAR(8), datetime → TIMESTAMP, string → TEXT.
    expect(sql).toMatch(/"dob"\s+CHAR\(8\)/);
    expect(sql).toMatch(/"seen_at"\s+TIMESTAMP/);
    expect(sql).toMatch(/"name"\s+TEXT/);

    // Row values: Alice's dob compacted; the long ISO form for Carol still
    // strips down to YMD; Bob's empty becomes NULL.
    expect(sql).toContain("'20260524'");
    expect(sql).toContain("'19900102'");
    expect(sql).toMatch(/'Bob',\s*NULL/);

    // datetime untouched — full ISO under quotes.
    expect(sql).toContain("'2026-05-24T14:30'");

    // Sanity: no leaked dash-form date literals (would mean we forgot the
    // YMD path for a row).
    expect(sql).not.toContain("'2026-05-24'");
  });
});
