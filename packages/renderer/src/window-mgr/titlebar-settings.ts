// packages/renderer/src/window-mgr/titlebar-settings.ts
//
// "Has the user switched this titlebar button off?" — the read side of the
// Settings fields `chrome/chrome-settings.ts` registers.
//
// A module of its own for the same reason `table/grid-settings.ts` is one: the
// `settings` plugin owns the tab and the window managers read it, and neither
// should import the other. A manager importing a plugin would invert the plugin
// model; a plugin importing a window manager would pull the whole window layer
// in for one string.

import { CHROME_SETTINGS_ID, buttonShownKey } from '../chrome/chrome-settings.js';

/** The `api.settings` subset this needs — the same shape grid-settings reads. */
export interface SettingsReader {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}

/**
 * Is this titlebar button switched off? Defaults to false — a button the user
 * has never expressed an opinion about is shown, which is what every titlebar
 * did before the setting existed.
 *
 * Read per window rather than cached: a window opens on a click, and a cache
 * would still be answering with the old value right after someone changed it in
 * the Settings dialog. Same reasoning as `readSortDescFirst`.
 */
export async function titlebarButtonHidden(settings: SettingsReader, id: string): Promise<boolean> {
  return (await settings.get<boolean>(CHROME_SETTINGS_ID, buttonShownKey('titlebar', id))) === false;
}
