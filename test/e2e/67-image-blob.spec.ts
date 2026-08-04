import { test, expect, type Page } from './fixtures.js';
import { bulkAddRows, createTable, panelDomId, waitForPanel } from './helpers.js';

/**
 * A photo column read out of a database holds the IMAGE, not a URL to one.
 * Northwind's `Employees.Photo` is a JPEG BLOB, which reaches a cell as a SQL
 * hex literal (`X'ffd8ffe0…'`) from a `.sql` dump, or as bytes / bare base64
 * from a binary reader. The image renderer showed "no image" for all of them.
 *
 * The fixture below is a REAL 1×1 PNG, so the browser has to actually decode
 * what the renderer hands it — a made-up byte string would render broken and the
 * assertion on `naturalWidth` would catch that.
 */

/** A valid 1×1 red PNG (69 bytes), base64. */
const IMG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

/** The same bytes as SQL hex — what a `.sql` dump of a BLOB column carries. */
function hexLiteral(b64: string): string {
  const bin = Buffer.from(b64, 'base64');
  return `X'${bin.toString('hex')}'`;
}

/**
 * The <img> a cell rendered. A Playwright locator, not `document.querySelector`:
 * the grid lives in a shadow root, which raw DOM queries do not cross.
 */
const imageIn = (page: Page, tableId: string, cellIndex: number) =>
  page
    .locator(`#${panelDomId(tableId)} data-table tbody td`)
    .nth(cellIndex)
    .locator('img');

/** True once the browser has actually decoded the image — not just loaded a src. */
const decoded = (img: ReturnType<typeof imageIn>) =>
  img.evaluate((el) => {
    const i = el as HTMLImageElement;
    return i.complete && i.naturalWidth > 0;
  });

async function tableWithPhoto(page: Page, value: string) {
  const id = await createTable(page, 'Employees', [{ field: 'name' }, { field: 'photo', renderer: 'image' }]);
  await waitForPanel(page, id);
  await bulkAddRows(page, id, [{ name: 'Davolio', photo: value }]);
  return id;
}

test('a SQL hex blob renders as a picture', async ({ page }) => {
  const id = await tableWithPhoto(page, hexLiteral(IMG_B64));

  const img = imageIn(page, id, 1);
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => decoded(img)).toBe(true);
});

test('bare base64 renders as a picture', async ({ page }) => {
  const id = await tableWithPhoto(page, IMG_B64);
  const img = imageIn(page, id, 1);
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => decoded(img)).toBe(true);
});

test('an octet-stream data URI is re-typed from its bytes', async ({ page }) => {
  const id = await tableWithPhoto(page, `data:application/octet-stream;base64,${IMG_B64}`);
  const img = imageIn(page, id, 1);
  await expect(img).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => decoded(img)).toBe(true);
});

test('ordinary text still shows "no image"', async ({ page }) => {
  const id = await tableWithPhoto(page, 'Sales Representative');
  const cell = page.locator(`#${panelDomId(id)} data-table tbody td`).nth(1);
  await expect(cell).toContainText('no image');
  await expect(imageIn(page, id, 1)).toHaveCount(0);
});

test('an imported blob column gets the image renderer on its own', async ({ page }) => {
  // No renderer set: auto-renderer has to recognise the bytes and choose one.
  const id = await createTable(page, 'Staff', [{ field: 'name' }, { field: 'photo' }]);
  await waitForPanel(page, id);
  await page.evaluate(
    async ({ tableId, value }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = (window as any).__easydb;
      await ctx.store.rows(tableId).bulkInsert([
        {
          id: crypto.randomUUID(),
          tableId,
          data: { name: 'Davolio', photo: value },
          updatedAt: Date.now(),
        },
      ]);
      // The hook the importers fire once rows have landed.
      ctx.events.emit('import:after', { source: 'test', tableId, rowCount: 1 });
    },
    { tableId: id, value: hexLiteral(IMG_B64) },
  );

  await expect
    .poll(async () =>
      page.evaluate(async (tableId) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = await (window as any).__easydb.store.tables.findOne(tableId);
        return (t?.columns as Array<{ field: string; renderer?: string }>).find((c) => c.field === 'photo')?.renderer;
      }, id),
    )
    .toBe('image');
});
