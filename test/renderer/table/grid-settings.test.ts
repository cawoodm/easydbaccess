import { describe, expect, it } from 'vitest';
import { GRID_SETTINGS_ID, readHighlightNulls, readSortDescFirst } from '../../../packages/renderer/src/table/grid-settings.js';

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
