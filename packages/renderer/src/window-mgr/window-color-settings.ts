// packages/renderer/src/window-mgr/window-color-settings.ts
//
// The `windows:colors` setting, and the one place that pushes it into the live
// list in `window-color.ts`.
//
// Its own module for the reason `util/link-settings.ts` and
// `table/grid-settings.ts` have one: the `settings` plugin REGISTERS the field
// because it owns the Settings dialog, and the picker READS the list while the
// user is clicking. Neither may import the other — window management is core and
// a core module importing a plugin would invert the plugin model.
//
// Resolved ONCE at boot into module state and re-resolved when the dialog reports
// a change, because `createColorButton` builds its swatches inside a click
// handler and `api.settings.get` is async.

import { SETTINGS_CHANGED_EVENT, type SettingsChangedDetail } from '../db/settings-events.js';
import { DEFAULT_WINDOW_COLOR_LIST, parseWindowColors, setWindowColors } from './window-color.js';

export const WINDOWS_SETTINGS_ID = 'windows';
export const WINDOW_COLORS_KEY = 'colors';

/** Just enough of `SettingsApi` to read one value — so a test can pass a fake. */
export interface SettingsReader {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}

/** The setting's text, as the user wrote it. Empty ⇒ the shipped list. */
export async function readWindowColorList(settings: SettingsReader): Promise<string> {
  const raw: unknown = await settings.get<string>(WINDOWS_SETTINGS_ID, WINDOW_COLORS_KEY);
  return typeof raw === 'string' && raw.trim() !== '' ? raw : DEFAULT_WINDOW_COLOR_LIST;
}

/** Resolve the setting into the live list. */
export async function applyWindowColors(settings: SettingsReader): Promise<void> {
  setWindowColors(parseWindowColors(await readWindowColorList(settings)));
}

/**
 * Resolve it now and keep it resolved. Returns an unsubscribe, though nothing
 * calls it: the list is app-wide and lives as long as the page.
 *
 * A colour added to the list is offered by the next picker that opens — no
 * reload, because the picker is built fresh each time. Windows already painted
 * with a colour the user has just REMOVED keep it; the list says what may be
 * chosen, not what is allowed to exist.
 */
export function startWindowColors(settings: SettingsReader): () => void {
  void applyWindowColors(settings);
  if (typeof document === 'undefined') return () => {};
  const onChange = (e: Event) => {
    const detail = (e as CustomEvent<SettingsChangedDetail>).detail;
    if (detail?.pluginId !== WINDOWS_SETTINGS_ID) return;
    void applyWindowColors(settings);
  };
  document.addEventListener(SETTINGS_CHANGED_EVENT, onChange);
  return () => document.removeEventListener(SETTINGS_CHANGED_EVENT, onChange);
}
