import type { HostApi, PluginModule } from '@easydb/shared';
import { parseSecrets, readSecretsText, writeSecretsText } from '../db/user-settings.js';
import { GRID_SETTINGS_ID } from '../table/grid-settings.js';
import { DEFAULT_TILE_ATTRIBUTION, DEFAULT_TILE_URL, VIZ_SETTINGS_ID } from '../viz/viz-settings.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'settings',
  name: 'Settings',
  type: 'ui',
  // Core UX surface — always on, never shown with a disable toggle. The Plugin
  // Manager hides fixed plugins unless the "Fixed" filter is explicitly on.
  fixed: true,
  version: '0.1.0',
  description: 'Header gear button that opens the tabbed Settings dialog; imports dropped secrets.txt.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/settings.ts',
};

export function init(api: HostApi): void {
  api.ui.registerSettings(GRID_SETTINGS_ID, 'Table grid', [
    {
      key: 'sortDescFirst',
      label: 'Sort descending first',
      type: 'boolean',
      default: true,
      scope: 'workspace',
      description:
        'Clicking a column header sorts descending, then ascending, then off. Turn this off to start ascending. Dates, scores and counts are usually read from the high end down, which took two clicks before.',
    },
    {
      key: 'highlightNulls',
      label: 'Highlight empty cells',
      type: 'boolean',
      default: true,
      scope: 'workspace',
      description:
        'An empty cell gets a pink background, so a gap in the data is visible whatever the column draws. Turn it off for a table that is mostly empty on purpose, where the colour is noise. A value that does not fit its column type stays marked red either way.',
    },
  ]);

  // Visualization settings live here for the same reason the grid's do: this
  // plugin owns the Settings tab, and the elements that READ these values must
  // not import a plugin. See `viz/viz-settings.ts`.
  api.ui.registerSettings(VIZ_SETTINGS_ID, 'Visualizations', [
    {
      key: 'tileUrl',
      label: 'Map tile URL template',
      type: 'string',
      default: DEFAULT_TILE_URL,
      scope: 'workspace',
      description:
        'Where map visualizations fetch their background tiles. The default is OpenStreetMap, whose tile policy asks that heavy or commercial use runs its own server — point this at that server, or at a local one for an offline install. A map still plots its points when tiles cannot be loaded.',
      helpUrl: 'https://operations.osmfoundation.org/policies/tiles/',
      helpLinkLabel: 'OpenStreetMap tile usage policy',
    },
    {
      key: 'tileAttribution',
      label: 'Map attribution',
      type: 'string',
      default: DEFAULT_TILE_ATTRIBUTION,
      scope: 'workspace',
      description: 'Credit shown in the map corner. Most tile providers require this.',
    },
    {
      key: 'cloudMinLength',
      label: 'Word cloud: ignore words shorter than',
      type: 'number',
      default: 3,
      scope: 'workspace',
      description: 'A new word cloud starts with this. Three suits prose; raise it for noisy text, lower it for a column of codes.',
    },
    {
      key: 'cloudKeepWords',
      label: 'Word cloud: always keep these words',
      type: 'text',
      scope: 'workspace',
      description:
        'The exception to the length limit above — and to the ignore list below. Acronyms are often the most interesting terms in a column and the first thing a length limit throws away: AI, UI, CH, SQL. Separate with commas, spaces or new lines.',
    },
    {
      key: 'cloudStopWords',
      label: 'Word cloud: ignore these common words',
      type: 'text',
      scope: 'workspace',
      description:
        'Words too common to be interesting. Left as shipped this is an English function-word list, which is what stops "the" being the biggest word in every cloud — replace it wholesale for another language, or clear it to count everything. Separate with commas, spaces or new lines.',
    },
    {
      key: 'cloudMaxTerms',
      label: 'Word cloud: most words to lay out',
      type: 'number',
      default: 120,
      scope: 'workspace',
      description: 'The cloud layout runs on the main thread, so this is capped — a very high number makes the window unresponsive while it settles.',
    },
  ]);

  api.ui.registerHeaderButton({
    id: 'settings:open',
    label: 'Settings',
    icon: 'settings',
    tooltip: 'Workspace and plugin settings',
    variant: 'secondary',
    onClick: () => api.ui.openSettings(),
  });

  // Drag-and-drop a `secrets.txt` to load the device-local secrets store.
  // Registered first among built-ins so it claims the drop before the CSV/JSON
  // importers; it only handles a file literally named `secrets.txt` and returns
  // false for anything else, so normal data imports are unaffected.
  api.ui.registerDropHandler(async (event, api) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const file = files.find((f) => f.name.toLowerCase() === 'secrets.txt');
    if (!file) return false;

    const text = await file.text();
    const count = Object.keys(parseSecrets(text)).length;

    if (readSecretsText().trim().length > 0) {
      const ok = await api.ui.dialogs.confirm(`Replace your current secrets with ${count} secret${count === 1 ? '' : 's'} from "${file.name}"?`, 'Import secrets');
      if (!ok) return true; // drop consumed, but the user declined
    }

    writeSecretsText(text);
    api.ui.dialogs.toast(`Imported ${count} secret${count === 1 ? '' : 's'}.`, {
      kind: 'success',
      title: 'Secrets',
    });
    return true;
  });
}
