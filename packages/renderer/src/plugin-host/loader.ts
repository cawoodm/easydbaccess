import type { HostApi, PluginModule } from '@easydb/shared';
import * as csvImport from '../plugins/csv-import.js';
import * as csvExport from '../plugins/csv-export.js';
import * as jsonImport from '../plugins/json-import.js';
import * as dumpExport from '../plugins/dump-export.js';
import * as gistSync from '../plugins/gist-sync.js';
import * as newTableButton from '../plugins/new-table-button.js';
import * as pluginManagerButton from '../plugins/plugin-manager-button.js';
import * as cellColor from '../plugins/cell-color.js';
import * as cellImage from '../plugins/cell-image.js';
import * as cellLink from '../plugins/cell-link.js';
import * as headerClock from '../plugins/header-clock.js';

/**
 * Built-in plugins shipped with the renderer. They satisfy the same
 * PluginModule contract as URL-loaded plugins; the only difference is the
 * delivery mechanism (static import vs. dynamic import of a Blob URL).
 */
const builtins: PluginModule[] = [
  newTableButton,
  csvImport,
  jsonImport,
  csvExport,
  dumpExport,
  gistSync,
  pluginManagerButton,
  cellColor,
  cellImage,
  cellLink,
  headerClock,
];

/**
 * Runs init() on every built-in plugin. Returns a function that runs load()
 * on all of them once the app shell is ready.
 */
export async function loadBuiltinPlugins(api: HostApi): Promise<() => Promise<void>> {
  for (const p of builtins) {
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
    for (const p of builtins) {
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
