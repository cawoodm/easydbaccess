// packages/renderer/src/viz/viz-settings.ts
//
// The settings namespace visualizations read.
//
// It sits in its own module for the same dependency reason `table/grid-settings.ts`
// does: the `settings` plugin REGISTERS these fields (it owns the Settings tab)
// and the viz elements READ them, and neither should import the other — a core
// element importing a plugin would invert the plugin model, and a plugin
// importing an element would pull a charting library in for one string.

import { defaultStopWordsText } from './word-frequency.js';

export const VIZ_SETTINGS_ID = 'viz';

/**
 * The default map tile source. OpenStreetMap's public tiles, which carry a usage
 * policy (https://operations.osmfoundation.org/policies/tiles/) — hence the
 * setting: a deployment that expects real traffic, or one with no internet at
 * all, points this somewhere else.
 */
export const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const DEFAULT_TILE_ATTRIBUTION = '© OpenStreetMap contributors';

interface SettingsReader {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}

/**
 * Word-cloud DEFAULTS — what a NEW word cloud starts with, not a live override.
 *
 * They are copied into the template's own options the moment the kind is picked
 * (see `dialogs/views-dialog.ts`), rather than read at draw time like the map's
 * tile URL. The difference is deliberate: a tile server is infrastructure and
 * should change everywhere at once, while a word list is editorial. Changing the
 * workspace default must not silently rewrite clouds somebody already tuned.
 */
export interface CloudDefaults {
  minLength: number;
  keepWords: string;
  stopWords: string;
}

export async function readCloudDefaults(settings: SettingsReader): Promise<CloudDefaults> {
  const min = Number(await settings.get<number>(VIZ_SETTINGS_ID, 'cloudMinLength'));
  const keep = await settings.get<string>(VIZ_SETTINGS_ID, 'cloudKeepWords');
  const stop = await settings.get<string>(VIZ_SETTINGS_ID, 'cloudStopWords');
  return {
    minLength: Number.isFinite(min) && min > 0 ? Math.floor(min) : 3,
    keepWords: typeof keep === 'string' ? keep : '',
    // An empty string is a real answer here ("drop nothing"), so only an ABSENT
    // setting falls back to the built-in list.
    stopWords: typeof stop === 'string' ? stop : defaultStopWordsText(),
  };
}

/**
 * The tile URL template. Read per map mount rather than cached: a map is not a
 * hot path, and `easydb:settings-changed` is what tells an open one to re-read.
 */
export async function readTileUrl(settings: SettingsReader): Promise<string> {
  const v = await settings.get<string>(VIZ_SETTINGS_ID, 'tileUrl');
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_TILE_URL;
}

export async function readTileAttribution(settings: SettingsReader): Promise<string> {
  const v = await settings.get<string>(VIZ_SETTINGS_ID, 'tileAttribution');
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : DEFAULT_TILE_ATTRIBUTION;
}

/**
 * How many terms a word cloud will lay out. Capped because the layout is
 * O(terms x placement attempts) and runs on the main thread — see
 * `viz/word-frequency.ts`.
 */
export async function readCloudMaxTerms(settings: SettingsReader): Promise<number> {
  const v = await settings.get<number>(VIZ_SETTINGS_ID, 'cloudMaxTerms');
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 120;
}
