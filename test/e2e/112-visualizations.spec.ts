import { test, expect } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * Visualizations: a `ViewTemplate` whose `kind` is `'viz'`, bound to a table by a
 * `ViewInstance` whose `mapping` keys are data CHANNELS rather than `$TOKEN`s.
 *
 * The assertions lean on the hidden `<table class="a11y">` the chart elements
 * render beside their canvas. A canvas has no readable content, so that table is
 * both the accessible equivalent AND the only way to check what was actually
 * plotted — reading pixels would test Chart.js, not this app.
 */

// Counts are deliberately distinct (CH 3, DE 2, AT 1) so the ordering assertion
// tests ORDER rather than tie-breaking. Rows come back in the store's order, not
// insertion order, so a tie here would make the first bar ambiguous — the
// aggregator breaks such ties by label, and that is covered by a unit test.
const CITIES = [
  { country: 'CH', city: 'Bern', amount: 10 },
  { country: 'CH', city: 'Zug', amount: 7 },
  { country: 'CH', city: 'Chur', amount: 4 },
  { country: 'DE', city: 'Bonn', amount: 5 },
  { country: 'DE', city: 'Kiel', amount: 3 },
  { country: 'AT', city: 'Graz', amount: 1 },
];

/** Create a table with the fixture rows, through the store rather than the UI. */
async function seedCities(page: import('@playwright/test').Page, name = 'Cities') {
  const id = await createTable(page, name, [{ field: 'country' }, { field: 'city' }, { field: 'amount', type: 'number' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, CITIES);
  return id;
}

/** Open the Views dialog from a table's footer. */
async function openViews(page: import('@playwright/test').Page, tableId: string) {
  await page
    .locator(`#${panelDomId(tableId)} panel-footer`)
    .getByRole('button', { name: /Views/ })
    .click();
  const dlg = page.locator('views-dialog dialog');
  await expect(dlg).toBeVisible();
  return dlg;
}

/**
 * Build a chart template and a view of it. `where` picks the dock option, which
 * is the one control that decides window vs. pane.
 */
async function makeChart(page: import('@playwright/test').Page, tableId: string, opts: { kind?: string; name?: string; where?: 'window' | 'above' | 'below' } = {}) {
  const dlg = await openViews(page, tableId);
  await dlg.getByRole('button', { name: '+ New visualization' }).click();
  await dlg
    .locator('input[type=text]')
    .first()
    .fill(opts.name ?? 'Chart');
  if (opts.kind) await dlg.locator('select').first().selectOption(opts.kind);
  await dlg.getByRole('button', { name: 'Save' }).click();

  const row = dlg.locator('ul.list li', { hasText: opts.name ?? 'Chart' });
  await row.getByRole('button', { name: 'Use' }).click();
  if (opts.where && opts.where !== 'window') {
    await dlg.locator('select').first().selectOption(opts.where);
  }
  await dlg.getByRole('button', { name: 'Create view' }).click();
}

test.describe('visualizations', () => {
  test('a bar chart of a table draws its aggregated numbers', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });

    // Its own window, holding a viz-panel with the bar element inside.
    const panel = page.locator('viz-panel');
    await expect(panel).toBeVisible();
    const chart = panel.locator('viz-bar-chart');
    await expect(chart).toBeVisible();

    // Default aggregate is count-of-rows by category, largest first — CH 3,
    // DE 2, AT 1. The a11y table is what the chart actually plotted.
    const a11y = chart.locator('table.a11y');
    await expect(a11y.locator('tbody tr')).toHaveCount(3);
    await expect(a11y.locator('tbody th[scope=row]')).toHaveText(['CH', 'DE', 'AT']);
    await expect(a11y.locator('tbody tr').first().locator('td')).toHaveText('3');
    // A canvas has no accessible content of its own, so the wrapper carries it.
    await expect(chart.locator('[role=img]')).toHaveAttribute('aria-label', /bar chart, 3 categories/);
  });

  test('switching the visualization kind redraws with the other element', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'Pie', kind: 'pie' });
    await expect(page.locator('viz-panel viz-pie-chart')).toBeVisible();
    await expect(page.locator('viz-panel viz-bar-chart')).toHaveCount(0);
  });

  test('a word cloud counts terms in a text column', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'alpha beta alpha' }, { body: 'alpha gamma' }]);
    await makeChart(page, id, { name: 'Words', kind: 'wordcloud' });

    const cloud = page.locator('viz-panel viz-word-cloud');
    await expect(cloud).toBeVisible();
    // The SVG is ours, so terms are real text nodes rather than canvas pixels.
    // Asserted by CONTENT, not `toBeVisible`: a laid-out word can sit partly
    // outside the viewBox, which Playwright's visibility heuristic reads as
    // hidden even though the term was placed and sized correctly.
    const terms = cloud.locator('text');
    await expect(terms.filter({ hasText: 'alpha' }).first()).toHaveText(/alpha/);
    await expect(terms.filter({ hasText: 'beta' }).first()).toHaveText(/beta/);
    // Sized by frequency: alpha occurs 3x, beta once, so alpha must be bigger.
    const sizeOf = async (word: string): Promise<number> => Number(await terms.filter({ hasText: word }).first().getAttribute('font-size'));
    expect(await sizeOf('alpha')).toBeGreaterThan(await sizeOf('beta'));
    await expect(cloud.locator('[role=img]')).toHaveAttribute('aria-label', /largest alpha/);
  });

  test('a word cloud of uniform-frequency prose places nearly every term', async ({ page }) => {
    // The reported bug: every word in ordinary prose occurs once, so every count
    // was equal — and equal counts were sized at the MAXIMUM, which for a 468x512
    // window meant 93px each. d3-cloud silently drops what it cannot place, so 53
    // terms rendered as 6 words and the cloud looked empty.
    const prose = [
      'The quick brown fox jumps over the lazy dog near the river bank',
      'Switzerland has mountains valleys lakes rivers glaciers and forests everywhere',
      'Database tables columns rows queries indexes joins projections and views',
      'Charts maps clouds bars lines pies scatter heatmaps and dashboards',
      'Zurich Geneva Basel Bern Lausanne Lucerne Lugano Winterthur StGallen Biel',
      'Analysis reporting visualization aggregation grouping filtering sorting counting',
    ];
    const id = await createTable(page, 'Prose', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(
      page,
      id,
      prose.map((body) => ({ body })),
    );
    await makeChart(page, id, { name: 'Prose cloud', kind: 'wordcloud' });

    const cloud = page.locator('viz-panel viz-word-cloud');
    await expect(cloud).toBeVisible();
    // Asserted as a RATIO of what was counted, not an absolute: the exact term
    // count depends on the stop list, and the bug was about the share that fit.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const panel = document.querySelector('viz-panel') as { shadowRoot?: ShadowRoot | null } | null;
            const el = panel?.shadowRoot?.querySelector('viz-word-cloud') as { terms?: unknown[]; placed?: unknown[] } | null;
            const terms = el?.terms?.length ?? 0;
            const placed = el?.placed?.length ?? 0;
            return terms === 0 ? 0 : placed / terms;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0.8);
  });

  test('a visualization window has an Edit button that opens its mapping', async ({ page }) => {
    // A chart's whole content is a configuration, and before this the only route
    // back to it was the table's Views button — not discoverable from the chart.
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    const footer = page.locator('viz-footer');
    await expect(footer).toBeVisible();
    await expect(footer.getByRole('button', { name: 'Settings for this view' })).toBeVisible();
    await expect(footer.getByRole('button', { name: 'Edit definition' })).toBeVisible();

    await footer.getByRole('button', { name: 'Settings for this view' }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    // Straight onto this instance's edit form, with its channels listed by label
    // rather than as `$TOKEN`s.
    await expect(dlg).toContainText('Map data to columns');
    await expect(dlg).toContainText('Category (group by)');
  });

  test('the Chart button opens the template, where the kind and aggregate live', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    await page.locator('viz-footer').getByRole('button', { name: 'Edit definition' }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('What it measures');
    await expect(dlg).toContainText('Visualization');
  });

  test('word cloud terms are real SVG text, not HTML elements named text', async ({ page }) => {
    // The regression this pins: the per-word fragment was built with Lit's `html`
    // instead of `svg`. Lit parses each nested template independently, so the
    // `<text>` nodes were created in the HTML namespace — present in the DOM,
    // carrying every attribute, found by `querySelectorAll('text')`, and drawn by
    // nothing. Every earlier assertion passed while the cloud was blank, because
    // all of them checked content and attributes rather than namespace.
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'alpha beta alpha' }, { body: 'alpha gamma delta' }]);
    await makeChart(page, id, { name: 'NS cloud', kind: 'wordcloud' });
    await expect(page.locator('viz-panel viz-word-cloud')).toBeVisible();

    // The layout is async (lazy d3-cloud import, then a placement pass), so poll
    // until words exist rather than probing the moment the element mounts.
    const readProbe = () =>
      page.evaluate(() => {
        const vp = document.querySelector('viz-panel') as { shadowRoot?: ShadowRoot | null } | null;
        const cloud = vp?.shadowRoot?.querySelector('viz-word-cloud') as { shadowRoot?: ShadowRoot | null } | null;
        const texts = [...(cloud?.shadowRoot?.querySelectorAll('text') ?? [])];
        return {
          count: texts.length,
          allSvgNs: texts.every((t) => t.namespaceURI === 'http://www.w3.org/2000/svg'),
          // A real SVG text has geometry; an HTML element named `text` has no
          // getBBox at all, which is the cheapest possible proof of the namespace.
          allHaveGeometry: texts.every((t) => typeof (t as SVGGraphicsElement).getBBox === 'function' && (t as SVGGraphicsElement).getBBox().width > 0),
        };
      });

    await expect.poll(async () => (await readProbe()).count, { timeout: 15_000 }).toBeGreaterThan(0);
    const probe = await readProbe();
    expect(probe.allSvgNs).toBe(true);
    expect(probe.allHaveGeometry).toBe(true);
  });

  test('a visualization window has a footer with a way back to its config', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    const win = page.locator('.jsPanel', { has: page.locator('viz-panel') });
    const footer = win.locator('.jsPanel-ftr');
    await expect(footer).toBeVisible();
    // Tall enough to read as a footer: it measured 18px when the type was 11px
    // with no padding, which is why it went unnoticed.
    expect((await footer.boundingBox())!.height).toBeGreaterThan(28);

    const vf = footer.locator('viz-footer');
    await expect(vf.getByRole('button', { name: 'Settings for this view' })).toBeVisible();
    await expect(vf.getByRole('button', { name: 'Edit definition' })).toBeVisible();
    // Icons come from the shared `.mi` class — `.material-icons` has no rules in a
    // shadow root, so the ligature rendered as the literal word "edit".
    const iconFont = await vf
      .locator('span.mi')
      .first()
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(iconFont).toContain('Material Icons');
  });

  test('Save closes the dialog when it was opened straight onto an editor', async ({ page }) => {
    // Arriving from a chart's own footer means the user came to change ONE thing.
    // The list is somewhere they never asked to be, so Save finishes.
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    const win = page.locator('.jsPanel', { has: page.locator('viz-panel') });
    const dlg = page.locator('views-dialog dialog');

    // The Chart button — the template editor (kind, aggregate, options).
    await win.locator('viz-footer').getByRole('button', { name: 'Edit definition' }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeHidden();

    // The Edit button — the instance editor (which column feeds which channel).
    await win.locator('viz-footer').getByRole('button', { name: 'Settings for this view' }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeHidden();
  });

  test('Save returns to the list when the user navigated there themselves', async ({ page }) => {
    // The other half of the rule: someone browsing the Views list was not asking
    // to be thrown out of it, and may well want to edit something else.
    const id = await seedCities(page);
    const dlg = await openViews(page, id);
    await dlg.getByRole('button', { name: '+ New visualization' }).click();
    await dlg.locator('input[type=text]').first().fill('Stays open');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('ul.list li', { hasText: 'Stays open' })).toBeVisible();
  });

  test('a chart mapped to an EMPTY column says so instead of drawing nothing', async ({ page }) => {
    // The reported case, and the commonest way a chart looks broken: the column
    // exists and is simply empty. Picking the wrong one from a dropdown of a dozen
    // is easy, and a blank pane is indistinguishable from a broken feature.
    const id = await createTable(page, 'Notes', [{ field: 'body' }, { field: 'blank' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'alpha beta' }, { body: 'gamma delta' }]);
    await makeChart(page, id, { name: 'Empty col', kind: 'wordcloud' });

    // Remap TEXT onto the column that holds nothing.
    await page.evaluate(async () => {
      const w = window as unknown as {
        __easydb: { store: { viewInstances: { find(): Promise<Array<{ id: string; mapping: Record<string, string> }>>; patch(id: string, p: unknown): Promise<void> } } };
      };
      const insts = await w.__easydb.store.viewInstances.find();
      const inst = insts[0]!;
      await w.__easydb.store.viewInstances.patch(inst.id, { mapping: { ...inst.mapping, TEXT: 'blank' }, updatedAt: Date.now() });
    });

    const err = page.locator('viz-panel .error');
    await expect(err).toContainText(/is empty in all 2 rows/i);
    // It names the column the user picked, and where to change it.
    await expect(err).toContainText(/blank/i);
    await expect(err).toContainText(/Edit/);
  });

  test('word-cloud settings seed a NEW cloud and are overridable per view', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'AI ui alpha alpha beta' }, { body: 'AI gamma delta' }]);

    // Workspace DEFAULTS: keep the acronyms a length limit would throw away.
    await page.evaluate(async () => {
      const w = window as unknown as { __easydb: { api: { settings: { set(p: string, k: string, v: unknown): Promise<void> } } } };
      await w.__easydb.api.settings.set('viz', 'cloudMinLength', 4);
      await w.__easydb.api.settings.set('viz', 'cloudKeepWords', 'AI, UI');
    });

    await makeChart(page, id, { name: 'Cloud', kind: 'wordcloud' });
    const cloud = page.locator('viz-panel viz-word-cloud');
    await expect(cloud).toBeVisible();

    const terms = async (): Promise<string[]> =>
      page.evaluate(() => {
        const vp = document.querySelector('viz-panel') as { shadowRoot?: ShadowRoot | null } | null;
        const el = vp?.shadowRoot?.querySelector('viz-word-cloud') as { terms?: Array<{ term: string }> } | null;
        return (el?.terms ?? []).map((t) => t.term);
      });

    // minLength 4 dropped "beta"(4 is ok) — check the exception list instead:
    // "AI" is two letters and survived only because it was named.
    await expect.poll(terms).toContain('AI');
    expect(await terms()).toContain('ui');

    // Now OVERRIDE on this view only: raise the limit and drop the exceptions.
    const win = page.locator('.jsPanel', { has: page.locator('viz-panel') });
    await win.locator('viz-footer').getByRole('button', { name: 'Settings for this view' }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg.locator('.viz-override')).not.toHaveCount(0);
    const keepField = dlg.locator('.viz-override', { hasText: 'Always keep these words' }).locator('textarea');
    await keepField.fill('');
    await dlg.getByRole('button', { name: 'Save' }).click();
    await expect(dlg).toBeHidden();

    // The acronyms are gone for THIS view; the template still says to keep them.
    await expect.poll(terms).not.toContain('AI');
    const stored = await page.evaluate(async () => {
      const w = window as unknown as { __easydb: { store: { viewInstances: { find(): Promise<Array<{ vizOptions?: Record<string, unknown> }>> } } } };
      return (await w.__easydb.store.viewInstances.find()).map((v) => v.vizOptions ?? null);
    });
    // Only the CHANGED key is stored — everything else keeps inheriting.
    expect(Object.keys(stored[0] ?? {})).toEqual(['keepWords']);
  });

  test('a word cloud exports its words and counts as CSV', async ({ page }) => {
    const id = await createTable(page, 'Notes', [{ field: 'body' }]);
    await waitForPanel(page, id);
    await bulkAddRows(page, id, [{ body: 'alpha beta alpha' }, { body: 'alpha gamma' }]);
    await makeChart(page, id, { name: 'Top words', kind: 'wordcloud' });
    await expect(page.locator('viz-panel viz-word-cloud')).toBeVisible();

    const win = page.locator('.jsPanel', { has: page.locator('viz-panel') });
    const download = page.waitForEvent('download');
    await win.locator('viz-footer').getByRole('button', { name: 'Export as CSV' }).click();
    const dl = await download;
    // Named after the VIEW, not the template — a new instance is auto-named
    // "<template> — <table>", which is what the user sees in the titlebar.
    expect(dl.suggestedFilename()).toBe('Top-words-Notes.csv');

    const stream = await dl.createReadStream();
    const text = await new Promise<string>((resolve, reject) => {
      let out = '';
      stream.on('data', (c: Buffer) => (out += c.toString('utf8')));
      stream.on('end', () => resolve(out));
      stream.on('error', reject);
    });
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('Word,Count');
    // Ranked, so the most frequent term is the first row.
    expect(lines[1]).toBe('alpha,3');
    expect(lines.length).toBeGreaterThan(2);
  });

  test('a chart says so when its column was renamed away, instead of drawing nothing', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    await expect(page.locator('viz-panel viz-bar-chart')).toBeVisible();

    // Rename the mapped column OUT from under the chart, bypassing the editor's
    // reference-carrying save — this is the raw "mapping points at nothing" case.
    await page.evaluate(async (tableId) => {
      const ctx = (window as unknown as { __easydb: { store: { tables: { findOne(id: string): Promise<{ columns: unknown[] }>; patch(id: string, p: unknown): Promise<void> } } } }).__easydb;
      const t = await ctx.store.tables.findOne(tableId);
      const columns = (t.columns as Array<{ field: string }>).map((c) => (c.field === 'country' ? { ...c, field: 'land' } : c));
      await ctx.store.tables.patch(tableId, { columns, updatedAt: Date.now() });
    }, id);

    // "No data" and "you renamed the column" look identical on a chart, so it has
    // to name the channel rather than render an empty plot.
    await expect(page.locator('viz-panel .error')).toContainText(/No column mapped for/i);
  });

  test('a renamed column is carried into the chart mapping by the columns editor', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    const a11y = page.locator('viz-panel viz-bar-chart table.a11y');
    await expect(a11y.locator('tbody tr')).toHaveCount(3);

    // Rename through the real editor path, which repoints references.
    await page.evaluate(async (tableId) => {
      const w = window as unknown as {
        __easydb: {
          store: {
            tables: { findOne(id: string): Promise<{ name: string; columns: unknown[] }> };
            viewInstances: { find(q?: unknown): Promise<Array<{ id: string; tableId: string; mapping: Record<string, string> }>> };
          };
        };
      };
      const mod = await import('/src/table/table-references.ts');
      const insts = (await w.__easydb.store.viewInstances.find()).filter((v) => v.tableId === tableId);
      // Exercise the helper the editor's submit calls.
      for (const v of insts) {
        const patch = (mod as { renameViewMappings(i: unknown, r: unknown[]): Record<string, unknown> | null }).renameViewMappings(v, [{ from: 'country', to: 'land' }]);
        if (patch) Object.assign(v, patch);
      }
      (window as unknown as { __renamed: unknown }).__renamed = insts.map((v) => v.mapping);
    }, id);

    const mappings = await page.evaluate(() => (window as unknown as { __renamed: Array<Record<string, string>> }).__renamed);
    expect(mappings[0]?.['CATEGORY']).toBe('land');
  });
});

test.describe('the measure is a setting a single view can override', () => {
  /** The numbers the bar chart actually plotted, per category. */
  const plotted = (page: import('@playwright/test').Page) =>
    page.locator('viz-panel viz-bar-chart table.a11y tbody tr').evaluateAll((rows) =>
      rows.map((r) => [r.querySelector('th')?.textContent ?? '', r.querySelector('td')?.textContent ?? '']),
    );

  test('Settings changes SUM for this view; the definition keeps counting', async ({ page }) => {
    // The definition says "count rows per country". One view of it should be
    // able to say "sum the amount instead" without forking the template — the
    // same layering `vizOptions` already had, applied to the measure.
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    await expect.poll(() => plotted(page)).toEqual([
      ['CH', '3'],
      ['DE', '2'],
      ['AT', '1'],
    ]);

    await page.locator('viz-footer').getByRole('button', { name: 'Settings for this view' }).click();
    const dlg = page.locator('views-dialog dialog');
    await expect(dlg).toBeVisible();
    await dlg.locator('label.field', { hasText: 'Aggregate' }).locator('select').selectOption('sum');
    await dlg.getByRole('button', { name: 'Save', exact: true }).click();

    // CH 10+7+4, DE 5+3, AT 1 — and still largest-first, which was not overridden.
    await expect.poll(() => plotted(page)).toEqual([
      ['CH', '21'],
      ['DE', '8'],
      ['AT', '1'],
    ]);

    // The DEFINITION is untouched — the override is a delta, not a fork, so
    // editing the template later still reaches every view that never changed it.
    await page.locator('viz-footer').getByRole('button', { name: 'Edit definition' }).click();
    await expect(dlg).toBeVisible();
    await expect(dlg).toContainText('What it measures');
    await expect(dlg.locator('label.field', { hasText: 'Aggregate' }).locator('select')).toHaveValue('count');
  });

  test('Reset puts the measure back to following the definition', async ({ page }) => {
    const id = await seedCities(page);
    await makeChart(page, id, { name: 'By country' });
    await page.locator('viz-footer').getByRole('button', { name: 'Settings for this view' }).click();
    const dlg = page.locator('views-dialog dialog');
    const field = dlg.locator('.viz-override', { hasText: 'Aggregate' });

    await field.locator('select').selectOption('sum');
    // Marked as overridden, with a way back — an override you cannot see is one
    // you cannot undo.
    await expect(field).toHaveClass(/changed/);
    await field.getByRole('button', { name: 'Reset' }).click();
    await expect(field).not.toHaveClass(/changed/);
    await expect(field.locator('select')).toHaveValue('count');
  });
});
