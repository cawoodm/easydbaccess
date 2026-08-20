import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from './fixtures.js';

/**
 * The shipped demo workspace actually works.
 *
 * `docs/help/workspace.db.json` exists to be dropped into a fresh install and
 * show every visualization kind at once — two docked panes over one grid, plus a
 * map, a column chart, a line, a pie and a second word cloud with per-instance
 * overrides. A fixture that has drifted from the code is worse than no fixture,
 * because the first thing it teaches a new user is that the feature is broken.
 * So it is imported here through the real drop handler and the real reconcilers.
 *
 * It also covers a path nothing else does: view INSTANCES arriving with dock
 * information from a file, bound to their table by NAME (the ids in the file are
 * not the ids the import mints).
 */

const FIXTURE = readFileSync(fileURLToPath(new URL('../../docs/help/workspace.db.json', import.meta.url)), 'utf8');

/** Drop it the way a user does — through `registries.dropHandlers`. */
async function dropFixture(page: import('@playwright/test').Page, text: string) {
  return page.evaluate(async (body) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (window as any).__easydb;
    const dt = new DataTransfer();
    dt.items.add(new File([body], 'workspace.db.json', { type: 'application/json' }));
    const event = new DragEvent('drop', { bubbles: true, dataTransfer: dt });
    for (const fn of ctx.registries.dropHandlers) {
      if (await fn(event, ctx.api)) break;
    }
  }, text);
}

test.describe('the shipped demo workspace', () => {
  test('imports and draws every visualization kind', async ({ page }) => {
    const pending = dropFixture(page, FIXTURE);
    // One table, so the import goes straight through with no table-picker.
    await pending;

    // The grid, with the fixture's rows.
    const grid = page.locator('data-table').first();
    await expect(grid).toBeVisible();
    // By count, not by first row: nothing sorts the import, so row order is the
    // order the ids were minted in.
    await expect(grid.locator('tbody tr:not(.spacer)').first()).toBeVisible();
    const rowCount = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find((x: { name: string }) => x.name === 'Trips');
      return (await store.rows(t.id).find()).length;
    });
    expect(rowCount).toBe(48);

    // Two docked panes on the one window — the layout the fixture exists to show.
    const host = page.locator('.jsPanel', { has: page.locator('data-table') }).first();
    await expect(host.locator('.panel-stack-above viz-pane')).toHaveCount(1);
    await expect(host.locator('.panel-stack-below viz-pane')).toHaveCount(1);
    // Docked above: the cloud, with real words in it.
    await expect(host.locator('.panel-stack-above viz-word-cloud text').first()).toHaveText(/\w+/);
    // Docked below: trips per country, one bar per country in the data.
    const bars = host.locator('.panel-stack-below viz-bar-chart table.a11y tbody tr');
    await expect(bars.first()).toContainText('CH');

    // And one window per remaining kind, each drawing rather than reporting.
    for (const tag of ['viz-point-map', 'viz-column-chart', 'viz-line-chart', 'viz-pie-chart']) {
      await expect(page.locator(`viz-panel ${tag}`)).toBeVisible();
    }
    // The windowed cloud carries per-instance overrides (minLength 6, maxTerms 40),
    // so it must show FEWER terms than the pane charting the same column — the
    // three-layer options model, visible on screen at once.
    const counts = await page.evaluate(() => {
      // A pane keeps its `viz-panel` inside its own shadow root, so a plain
      // document query finds only the windowed ones.
      const panels = [
        ...Array.from(document.querySelectorAll('viz-panel')),
        ...Array.from(document.querySelectorAll('viz-pane')).flatMap((p) => Array.from((p as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.querySelectorAll('viz-panel') ?? [])),
      ];
      const out: number[] = [];
      for (const vp of panels) {
        const el = (vp as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.querySelector('viz-word-cloud') as (Element & { terms?: unknown[] }) | null;
        if (el) out.push(el.terms?.length ?? 0);
      }
      return out;
    });
    expect(counts.length).toBe(2);
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.min(...counts)).toBeLessThan(Math.max(...counts));

    // And the dock itself survived re-identification: the file names its host by a
    // table id the import does not keep, so an unmapped dock leaves the pane
    // mounted nowhere and the chart invisible.
    const docks = await page.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      const t = (await store.tables.find()).find((x: { name: string }) => x.name === 'Trips');
      const all = (await store.viewInstances.find()) as Array<{ dock?: { edge: string; host: { kind: string; tableId?: string } } }>;
      return all.filter((v) => v.dock).map((v) => ({ edge: v.dock!.edge, hostIsTrips: v.dock!.host.tableId === t.id }));
    });
    expect(docks).toHaveLength(2);
    expect(docks.every((d) => d.hostIsTrips)).toBe(true);
    expect(docks.map((d) => d.edge).sort()).toEqual(['above', 'below']);

    // The `topN` tail is drawn grey rather than given a palette colour, so
    // "Other" cannot look like the most interesting category in the chart. The
    // element cannot know which label the tail was folded into, so the panel has
    // to tell it — and that wiring is only reachable from here.
    const muted = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('viz-panel'))
        .map((vp) => (vp as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot?.querySelector('viz-column-chart, viz-bar-chart, viz-pie-chart'))
        .filter((el): el is Element => Boolean(el))
        .map((el) => ((el as Element & { options?: Record<string, unknown> }).options ?? {})['mutedCategory']);
    });
    expect(muted.length).toBeGreaterThan(0);
    expect(muted).toContain('Other');

    // Nothing anywhere is reporting a broken chart.
    await expect(page.locator('viz-panel .error')).toHaveCount(0);
  });
});
