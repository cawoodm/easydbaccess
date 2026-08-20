import { describe, expect, it } from 'vitest';
import type { ButtonSpec } from '../../../packages/shared/src/plugin-api.js';
import { CHROME_SETTINGS_ID, buttonShownKey, buttonTextKey, chromeSettingsFields, readButtonText, readHiddenButtons } from '../../../packages/renderer/src/chrome/chrome-settings.js';

function reader(stored: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    get: async <T>(pluginId: string, key: string): Promise<T | undefined> => {
      asked.push(key);
      return stored[`${pluginId}:${key}`] as T | undefined;
    },
  };
}

function button(id: string, label: string, tooltip?: string): ButtonSpec {
  return { id, label, ...(tooltip ? { tooltip } : {}), onClick: () => {} };
}

describe('chrome settings', () => {
  it('is on unless the stored value says otherwise', async () => {
    const empty = reader({});
    expect(await readButtonText(empty, 'header')).toBe(true);
    expect(await readButtonText(empty, 'footer')).toBe(true);

    const off = reader({ [`${CHROME_SETTINGS_ID}:${buttonTextKey('footer')}`]: false });
    expect(await readButtonText(off, 'header')).toBe(true);
    expect(await readButtonText(off, 'footer')).toBe(false);
  });

  it('reads hidden ids per bar, and only asks about registered ones', async () => {
    const s = reader({
      [`${CHROME_SETTINGS_ID}:${buttonShownKey('header', 'import')}`]: false,
      // Same id in the other bar, and a leftover from a plugin no longer loaded.
      [`${CHROME_SETTINGS_ID}:${buttonShownKey('footer', 'import')}`]: true,
      [`${CHROME_SETTINGS_ID}:${buttonShownKey('header', 'gone')}`]: false,
    });

    expect([...(await readHiddenButtons(s, 'header', ['import', 'new-table']))]).toEqual(['import']);
    expect([...(await readHiddenButtons(s, 'footer', ['import']))]).toEqual([]);
    expect(s.asked).not.toContain(buttonShownKey('header', 'gone'));
  });

  it('builds one switch per registered button, on top of the two text switches', () => {
    const fields = chromeSettingsFields([button('new-table', 'New Table', 'Create a new table')], [button('export', 'Export')]);

    expect(fields.map((f) => f.key)).toEqual([buttonTextKey('header'), buttonTextKey('footer'), buttonShownKey('header', 'new-table'), buttonShownKey('footer', 'export')]);
    expect(fields.every((f) => f.type === 'boolean' && f.default === true)).toBe(true);
    // The button's own tooltip is the field's description — nothing invented.
    expect(fields[2]?.description).toBe('Create a new table');
    expect(fields[3]?.description).toBeUndefined();
  });
});
