import type { HostApi, PluginModule } from '@easydb/shared';
import * as csvImport from '../plugins/csv-import.js';
import * as csvExport from '../plugins/csv-export.js';
import * as jsonImport from '../plugins/json-import.js';
import * as datasetteSource from '../plugins/datasette-source.js';
import * as dumpExport from '../plugins/dump-export.js';
import * as sqlExport from '../plugins/sql-export.js';
import * as gistSync from '../plugins/gist-sync.js';
import * as serverSync from '../plugins/server-sync.js';
import * as newTableButton from '../plugins/new-table-button.js';
import * as pluginManagerButton from '../plugins/plugin-manager-button.js';
import * as coreRenderers from '../plugins/core-renderers.js';
import * as cellColor from '../plugins/cell-color.js';
import * as cellImage from '../plugins/cell-image.js';
import * as cellLink from '../plugins/cell-link.js';
import * as sampleData from '../plugins/sample-data.js';
import * as autoSync from '../plugins/auto-sync.js';

/**
 * Built-in plugins shipped with the renderer. They satisfy the same
 * PluginModule contract as URL-loaded plugins; the only difference is the
 * delivery mechanism (static import vs. dynamic import of a Blob URL).
 *
 * Plugins flagged `meta.optional = true` are still loaded by default, but the
 * user can disable them from the Plugin Manager. Disabled state is stored in
 * the plugins collection under the synthetic key `builtin:<name>`.
 */
const builtins: PluginModule[] = [
  newTableButton,
  csvImport,
  jsonImport,
  datasetteSource,
  csvExport,
  dumpExport,
  sqlExport,
  gistSync,
  serverSync,
  pluginManagerButton,
  coreRenderers,
  cellColor,
  cellImage,
  cellLink,
  sampleData,
  autoSync,
];

/** Public for the Plugin Manager dialog so it can render the optional list. */
export const builtinPlugins = builtins;

/** Synthetic URL used to key built-in disable state in the plugins collection. */
export function builtinKey(name: string): string {
  return `builtin:${name}`;
}

/**
 * Runs init() on every built-in plugin (skipping optional ones the user
 * disabled). Returns a function that runs load() on the same set once the
 * app shell is ready.
 */
export async function loadBuiltinPlugins(api: HostApi): Promise<() => Promise<void>> {
  const active: PluginModule[] = [];
  for (const p of builtins) {
    if (await isDisabled(api, p)) continue;
    active.push(p);
    try {
      await p.init?.(api);
    } catch (err) {
      api.events.emit('plugin:error', {
        url: p.meta?.name ?? '(builtin)',
        phase: 'init',
        error: err,
      });
    }
  }

  return async () => {
    for (const p of active) {
      try {
        await p.load?.(api);
      } catch (err) {
        api.events.emit('plugin:error', {
          url: p.meta?.name ?? '(builtin)',
          phase: 'load',
          error: err,
        });
      }
    }
  };
}

async function isDisabled(api: HostApi, p: PluginModule): Promise<boolean> {
  if (!p.meta?.optional) return false;
  const name = p.meta.name;
  if (!name) return false;
  const rec = await api.store.plugins.findOne(builtinKey(name));
  return rec?.enabled === false;
}
