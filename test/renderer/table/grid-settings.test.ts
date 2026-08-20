import { describe, expect, it } from 'vitest';
import { GRID_SETTINGS_ID, readHighlightNulls, readSortDescFirst, readWindowRowsFrom, WINDOW_ROWS_FROM_DEFAULT } from '../../../packages/renderer/src/table/grid-settings.js';
import { ROW_FETCH_CAP } from '../../../packages/renderer/src/db/data-store-bridge.js';

/**
 * Both grid preferences default to ON when unset, and only an explicit `false`
 * turns them off. That matters more than it looks: `undefined` is what every
 * workspace that predates the setting returns, and reading it as "off" would
 * silently change how an existing workspace behaves.
 */
const settings = (stored: Record<string, unknown>) => ({
  get: <T>(pluginId: string, key: string): Promise<T | undefined> => {
    expect(pluginId).toBe(GRID_SETTINGS_ID);
    return Promise.resolve(stored[key] as T | undefined);
  },
});

describe('grid settings', () => {
  it('highlights empty cells until the switch is explicitly off', async () => {
    expect(await readHighlightNulls(settings({}))).toBe(true);
    expect(await readHighlightNulls(settings({ highlightNulls: true }))).toBe(true);
    expect(await readHighlightNulls(settings({ highlightNulls: false }))).toBe(false);
  });

  it('does not read a stray value as off', async () => {
    // A dump or another device can put anything here; only `false` disables.
    expect(await readHighlightNulls(settings({ highlightNulls: null }))).toBe(true);
    expect(await readHighlightNulls(settings({ highlightNulls: 'false' }))).toBe(true);
  });

  it('keeps the two preferences apart', async () => {
    const only = settings({ highlightNulls: false });
    expect(await readHighlightNulls(only)).toBe(false);
    expect(await readSortDescFirst(only)).toBe(true);
  });
});

/**
 * The threshold from which a grid reads one page at a time. Unlike the two
 * switches it is a NUMBER, so the thing to protect is the difference between "not
 * set" (use the default) and "set to 0" (never window) — reading a blank field as
 * 0 would quietly stop windowing every table.
 */
describe('windowRowsFrom', () => {
  it('defaults to the read cap, never above it', () => {
    // The invariant the default exists to hold: a read that is NOT windowed is cut
    // off at `ROW_FETCH_CAP`, so a threshold above the cap leaves a band of table
    // sizes too big to read whole and too small to page — cut, with a note telling
    // the user to narrow a filter to reach rows paging would have reached.
    expect(WINDOW_ROWS_FROM_DEFAULT).toBe(ROW_FETCH_CAP);
  });

  it('defaults when unset', async () => {
    expect(await readWindowRowsFrom(settings({}))).toBe(WINDOW_ROWS_FROM_DEFAULT);
  });

  it('takes an explicit 0 as never window', async () => {
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: 0 }))).toBe(0);
  });

  it('takes a number, and a numeric string a dump may have written', async () => {
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: 1000 }))).toBe(1000);
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: '2500' }))).toBe(2500);
  });

  it('falls back rather than windowing on nonsense', async () => {
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: 'lots' }))).toBe(WINDOW_ROWS_FROM_DEFAULT);
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: -5 }))).toBe(WINDOW_ROWS_FROM_DEFAULT);
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: null }))).toBe(WINDOW_ROWS_FROM_DEFAULT);
  });

  it('floors a fraction, since it counts rows', async () => {
    expect(await readWindowRowsFrom(settings({ windowRowsFrom: 10.7 }))).toBe(10);
  });
});
