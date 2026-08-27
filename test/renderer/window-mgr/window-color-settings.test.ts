import { afterEach, describe, expect, it } from 'vitest';
import { applyWindowColors, readWindowColorList, startWindowColors, WINDOW_COLORS_KEY, WINDOWS_SETTINGS_ID } from '../../../packages/renderer/src/window-mgr/window-color-settings.js';
import { DEFAULT_WINDOW_COLOR_LIST, setWindowColors, WINDOW_COLORS, windowColors } from '../../../packages/renderer/src/window-mgr/window-color.js';

/**
 * The `windows:colors` setting is async and the picker that reads it is built
 * inside a click handler, so this module is the bridge: resolve once at boot into
 * module state, re-resolve on change. Same shape as `util/link-settings.ts`.
 */

function fakeSettings(value?: unknown): { get<T>(pluginId: string, key: string): Promise<T | undefined>; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    get<T>(pluginId: string, key: string): Promise<T | undefined> {
      reads.push(`${pluginId}:${key}`);
      return Promise.resolve(value as T | undefined);
    },
  };
}

afterEach(() => setWindowColors(null));

describe('readWindowColorList', () => {
  it('reads the one key the settings tab registers', async () => {
    const settings = fakeSettings('red,blue');
    expect(await readWindowColorList(settings)).toBe('red,blue');
    expect(settings.reads).toEqual([`${WINDOWS_SETTINGS_ID}:${WINDOW_COLORS_KEY}`]);
  });

  it('gives the shipped list for nothing stored, or a value that is not text', async () => {
    for (const stored of [undefined, null, '', '   ', 42]) {
      expect(await readWindowColorList(fakeSettings(stored))).toBe(DEFAULT_WINDOW_COLOR_LIST);
    }
  });
});

describe('applyWindowColors', () => {
  it('puts the stored list in force', async () => {
    await applyWindowColors(fakeSettings('#FF00DD,red,blue'));
    expect(windowColors().map((c) => c.value)).toEqual([null, '#FF00DD', 'red', 'blue']);
  });

  it('an unset setting leaves the shipped list in force', async () => {
    // Rebuilt from the default text rather than handed back, so the two have to
    // agree entry for entry — which is what keeps the field's default honest.
    await applyWindowColors(fakeSettings(undefined));
    expect(windowColors()).toEqual(WINDOW_COLORS);
  });

  it('a list of nothing usable leaves the shipped list in force', async () => {
    await applyWindowColors(fakeSettings('burgundy,,,'));
    expect(windowColors()).toBe(WINDOW_COLORS);
  });
});

describe('startWindowColors', () => {
  it('resolves the setting without waiting to be awaited, and survives having no document', async () => {
    // The unit suite runs in plain Node: no `document`, so the change listener is
    // skipped and the first read still has to happen.
    const stop = startWindowColors(fakeSettings('teal'));
    await Promise.resolve();
    await Promise.resolve();
    expect(windowColors().map((c) => c.value)).toEqual([null, 'teal']);
    expect(() => stop()).not.toThrow();
  });
});
