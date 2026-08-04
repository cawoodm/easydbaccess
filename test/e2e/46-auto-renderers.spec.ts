import { test, expect } from './fixtures.js';

/**
 * The `auto-renderer` built-in plugin gives freshly imported columns a renderer
 * based on their values: an image URL gets `image`, any other URL gets `link`,
 * markup or long prose gets `preview`.
 *
 * It listens on `import:after`, so it applies to EVERY importer without any of
 * them knowing about it — that is what makes "regardless of which plugin does
 * the import" true. The rules are unit-tested in `plugins/auto-renderer.test.ts`;
 * these specs prove the wiring.
 */

const LONG = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';

/** Field → renderer for an imported table, so a missing renderer shows as null. */
async function renderersOf(page: import('@playwright/test').Page, ws: string, name: string) {
  return page.evaluate(
    async ([w, n]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__easydb.store;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const t = (await store.tables.find()).find((x: any) => x.workspaceId === w && x.name === n);
      if (!t) return null;
      return Object.fromEntries(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        t.columns.map((c: any) => [c.field, c.renderer ?? null]),
      ) as Record<string, string | null>;
    },
    [ws, name],
  );
}

async function importUrl(page: import('@playwright/test').Page, url: string, kind: 'csv' | 'json') {
  await page.getByTitle('Import data from a URL').click();
  const dlg = page.locator('import-dialog dialog');
  await expect(dlg).toBeVisible();
  await dlg.locator('input[type="text"]').fill(url);
  await dlg.getByTestId('import-format').selectOption(kind);
  await dlg.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dlg).toBeHidden();
}

function serveText(page: import('@playwright/test').Page, url: string, body: string, type: string) {
  return page.route(url, (route) =>
    route.fulfill({
      status: 200,
      contentType: type,
      headers: { 'access-control-allow-origin': '*' },
      body,
    }),
  );
}

const PEOPLE_CSV = [
  'name,homepage,avatar,bio,joined,active',
  `Ada,https://example.com/ada,https://img.test/ada.png,"${LONG}",2026-01-02,true`,
  `Grace,https://example.com/grace,https://img.test/grace.jpg,"${LONG}",2026-03-04,false`,
].join('\n');

test('a CSV import picks link, image and preview from the values', async ({ page, workspaceId }) => {
  await serveText(page, 'https://ex.example/people.csv', PEOPLE_CSV, 'text/plain; charset=utf-8');
  await importUrl(page, 'https://ex.example/people.csv', 'csv');

  await expect
    .poll(() => renderersOf(page, workspaceId, 'people'))
    .toEqual({
      name: null, // short plain text — no renderer
      homepage: 'link',
      avatar: 'image',
      bio: 'preview',
      joined: 'date', // from the type, which csv-import already did
      active: 'boolean',
    });
});

test('a JSON import gets the same treatment, which it used not to get at all', async ({ page, workspaceId }) => {
  const rows = [
    {
      title: 'One',
      link: 'https://example.com/1',
      thumb: 'https://img.test/1.webp',
      html: '<p>hi</p>',
    },
    {
      title: 'Two',
      link: 'https://example.com/2',
      thumb: 'https://img.test/2.webp',
      html: '<p>ho</p>',
    },
  ];
  await serveText(page, 'https://ex.example/rows.json', JSON.stringify(rows), 'application/json');
  await importUrl(page, 'https://ex.example/rows.json', 'json');

  await expect
    .poll(() => renderersOf(page, workspaceId, 'rows'))
    .toEqual({
      title: null,
      link: 'link',
      thumb: 'image',
      html: 'preview',
    });
});

test('an explicit CSV header renderer is not overridden', async ({ page, workspaceId }) => {
  // `url:Url:color` pins the color renderer (the legacy color/image type names
  // map to a renderer) on a column whose values would otherwise infer `link`.
  const csv = 'url:Url:color\nhttps://example.com/a\nhttps://example.com/b\n';
  await serveText(page, 'https://ex.example/pinned.csv', csv, 'text/plain; charset=utf-8');
  await importUrl(page, 'https://ex.example/pinned.csv', 'csv');

  await expect.poll(() => renderersOf(page, workspaceId, 'pinned')).toEqual({ url: 'color' });
});

test('a mixed column is left as plain text rather than guessed at', async ({ page, workspaceId }) => {
  const csv = 'maybe\nhttps://example.com/a\nnot a url\n';
  await serveText(page, 'https://ex.example/mixed.csv', csv, 'text/plain; charset=utf-8');
  await importUrl(page, 'https://ex.example/mixed.csv', 'csv');

  await expect.poll(() => renderersOf(page, workspaceId, 'mixed')).toEqual({ maybe: null });
});

test('disabling the plugin turns the guessing off', async ({ page, workspaceId }) => {
  // Persist the built-in as disabled, then reload so the loader skips it.
  await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (window as any).__easydb.store.plugins.upsert({
      url: 'builtin:auto-renderer',
      enabled: false,
      lastFetched: 0,
    });
  });
  await page.reload();
  await page.waitForFunction(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => Boolean((window as any).__easydb),
    { timeout: 15_000 },
  );

  await serveText(page, 'https://ex.example/people.csv', PEOPLE_CSV, 'text/plain; charset=utf-8');
  await importUrl(page, 'https://ex.example/people.csv', 'csv');

  // Only the type-driven renderers csv-import assigns itself remain.
  await expect
    .poll(() => renderersOf(page, workspaceId, 'people'))
    .toEqual({
      name: null,
      homepage: null,
      avatar: null,
      bio: null,
      joined: 'date',
      active: 'boolean',
    });
});
