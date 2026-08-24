import { test, expect } from './fixtures.js';

/**
 * When a Datasette import is interrupted part-way (e.g. the instance rate-limits
 * a large import), the importer PROMPTS the user: wait 60s and resume now, or
 * cancel and keep the rows so far. Cancelling persists a resume cursor and shows
 * a RED "Resume import" button in the footer as a manual fallback; clicking it
 * continues from the stored page, appends the remaining rows, and clears the
 * button when the import completes. Choosing "Resume in 60s" instead waits the
 * (test-shortened) delay and continues inline without ever leaving a marker.
 */
const PAGE1 = {
  ok: true,
  next: 'p2', // more available → the importer follows to page 2
  truncated: false,
  columns: ['id', 'name', 'capacity_mw'],
  rows: [
    { id: 1, name: 'Kajaki Hydro', capacity_mw: 33 },
    { id: 2, name: 'Kandahar Solar', capacity_mw: 10 },
  ],
};
const PAGE2 = {
  ok: true,
  next: null, // exhausts the table
  truncated: false,
  columns: ['id', 'name', 'capacity_mw'],
  rows: [{ id: 3, name: 'Naghlu Dam', capacity_mw: 100 }],
};

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify(body),
});
const rateLimited = () => ({
  status: 429,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*' },
  body: JSON.stringify({ ok: false, error: 'rate limit exceeded' }),
});

test('cancelling the paused prompt keeps a red Resume button that continues from the stored page', async ({ page, workspaceId }) => {
  let page2Fails = true; // page-2 hop is rate-limited until we "recover"
  await page.route('https://ppl4.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    if (u.pathname === '/energy/plants.json') {
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra.includes('count')) return route.fulfill(json({ ok: true, count: 3 }));
      if (extra) return route.fulfill(json({ ok: true, columns: PAGE1.columns, rows: [] }));
      if (u.searchParams.get('_next') === 'p2') return route.fulfill(page2Fails ? rateLimited() : json(PAGE2));
      return route.fulfill(json(PAGE1));
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await importDialog.locator('input[type="text"]').fill('https://ppl4.example/energy/plants');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  // Page 2 is rate-limited → the paused prompt appears. Cancel it to keep the
  // partial and fall back to the footer resume button.
  const prompt = page.locator('host-dialogs dialog');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('Import paused — rate limited?');
  await prompt.locator('button.choice', { hasText: 'Cancel' }).click();

  // The table keeps 2 rows and a resume cursor.
  const tableId = await (async () => {
    await expect
      .poll(() =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find((x: { workspaceId: string; name: string }) => x.workspaceId === ws && x.name === 'energy/plants');
          if (!t) return null;
          const rows = await store.rows(t.id).find();
          return { rows: rows.length, resume: t.importResume?.loadedRows ?? null };
        }, workspaceId),
      )
      .toEqual({ rows: 2, resume: 2 });
    return page.evaluate(async (ws) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await (window as any).__easydb.store.tables.find()).find((x: { workspaceId: string; name: string }) => x.workspaceId === ws && x.name === 'energy/plants');
      return t.id as string;
    }, workspaceId);
  })();

  const panelDom = `panel-${tableId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const footer = page.locator(`#${panelDom} panel-footer`);
  const resumeBtn = footer.getByRole('button', { name: 'Resume import' });

  // The red resume button is shown (and carries the danger class → red styling).
  await expect(resumeBtn).toBeVisible();
  await expect(footer.locator('button.danger')).toBeVisible();

  // The server recovers; clicking Resume continues from page 2 and appends row 3.
  page2Fails = false;
  await resumeBtn.click();

  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = await store.tables.findOne(id);
        const rows = await store.rows(id).find();
        return { rows: rows.length, resume: t.importResume ?? null };
      }, tableId),
    )
    .toEqual({ rows: 3, resume: null }); // all rows in; resume cursor cleared

  // The red button disappears once the import is complete.
  await expect(resumeBtn).toHaveCount(0);
});

test('the paused prompt\'s "Resume in 60s" waits then continues inline, leaving no marker', async ({ page, workspaceId }) => {
  // Shorten the 60s auto-resume wait so the test doesn't stall a real minute.
  // Set on the already-loaded page — the seam is read at wait time.
  await page.evaluate(() => {
    (window as unknown as { __eda_resumeDelayMs: number }).__eda_resumeDelayMs = 200;
  });

  // Page 2 is rate-limited the FIRST time, then succeeds on the auto-resume.
  let page2Hits = 0;
  await page.route('https://ppl4.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    if (u.pathname === '/energy/plants.json') {
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra.includes('count')) return route.fulfill(json({ ok: true, count: 3 }));
      if (extra) return route.fulfill(json({ ok: true, columns: PAGE1.columns, rows: [] }));
      if (u.searchParams.get('_next') === 'p2') {
        page2Hits += 1;
        return route.fulfill(page2Hits === 1 ? rateLimited() : json(PAGE2));
      }
      return route.fulfill(json(PAGE1));
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await importDialog.locator('input[type="text"]').fill('https://ppl4.example/energy/plants');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  // The paused prompt appears; choose to wait and auto-resume.
  const prompt = page.locator('host-dialogs dialog');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('paused after 2 rows');
  await prompt.getByRole('button', { name: 'Resume in 60s' }).click();

  // After the (shortened) wait, page 2 succeeds inline: all 3 rows land and NO
  // resume marker is left (the import completed).
  await expect
    .poll(() =>
      page.evaluate(async (ws) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__easydb.store;
        const t = (await store.tables.find()).find((x: { workspaceId: string; name: string }) => x.workspaceId === ws && x.name === 'energy/plants');
        if (!t) return null;
        const rows = await store.rows(t.id).find();
        return { rows: rows.length, resume: t.importResume ?? null };
      }, workspaceId),
    )
    .toEqual({ rows: 3, resume: null });
  expect(page2Hits).toBe(2); // failed once, succeeded on the auto-resume
});

/**
 * The wait SAYS what it is doing.
 *
 * It always resumed on time — but for a real 60 seconds it showed one toast that
 * vanished, an indeterminate bar and an empty grid (the salvaged rows are not
 * written until the import ends), which is indistinguishable from a hang and was
 * reported as "resume after 60s doesn't work". The wait is only test-shortened to
 * 4s here; what matters is that the app bar counts it down.
 */
test('the wait counts itself down on the app progress bar', async ({ page, workspaceId }) => {
  await page.evaluate(() => {
    (window as unknown as { __eda_resumeDelayMs: number }).__eda_resumeDelayMs = 4_000;
  });

  let page2Hits = 0;
  await page.route('https://ppl4.example/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/-/metadata.json') return route.fulfill(json({}));
    if (u.pathname === '/energy/plants.json') {
      const extra = u.searchParams.get('_extra') ?? '';
      if (extra.includes('count')) return route.fulfill(json({ ok: true, count: 3 }));
      if (extra) return route.fulfill(json({ ok: true, columns: PAGE1.columns, rows: [] }));
      if (u.searchParams.get('_next') === 'p2') {
        page2Hits += 1;
        return route.fulfill(page2Hits === 1 ? rateLimited() : json(PAGE2));
      }
      return route.fulfill(json(PAGE1));
    }
    return route.fulfill({ status: 404, body: '{"ok":false}' });
  });

  await page.getByTitle('Import data from a URL').click();
  const importDialog = page.locator('import-dialog dialog');
  await importDialog.locator('input[type="text"]').fill('https://ppl4.example/energy/plants');
  await importDialog.getByTestId('import-format').selectOption('datasette');
  await importDialog.getByRole('button', { name: 'Import' }).click();

  const prompt = page.locator('host-dialogs dialog');
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Resume in 60s' }).click();

  // What is paused, and that the rows already fetched are not lost.
  const bar = page.locator('app-progress');
  await expect(bar).toContainText('paused — 2 rows kept');
  // A countdown, not a frozen number: whatever second it is caught on, a later
  // read must show a smaller one.
  // Through the element's own `.detail` span: `textContent()` on the host reads
  // the light DOM, and everything this element draws is in its shadow root.
  const seconds = async () => Number(/resuming in (\d+)s/.exec((await bar.locator('.detail').textContent()) ?? '')?.[1] ?? -1);
  const first = await seconds();
  expect(first).toBeGreaterThan(0);
  await expect.poll(seconds, { timeout: 6_000, intervals: [250] }).toBeLessThan(first);

  // And it still ends in the resumed rows.
  await expect
    .poll(
      () =>
        page.evaluate(async (ws) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const store = (window as any).__easydb.store;
          const t = (await store.tables.find()).find((x: { workspaceId: string; name: string }) => x.workspaceId === ws && x.name === 'energy/plants');
          if (!t) return null;
          return { rows: (await store.rows(t.id).find()).length, resume: t.importResume ?? null };
        }, workspaceId),
      { timeout: 20_000 },
    )
    .toEqual({ rows: 3, resume: null });
  // The bar does not keep the countdown once the wait is over.
  await expect(bar).not.toContainText('resuming in');
});
