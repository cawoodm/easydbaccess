import type { HostApi, PluginModule } from '@easydb/shared';
import * as csvImport from '../plugins/csv-import.js';
import * as csvExport from '../plugins/csv-export.js';
import * as jsonImport from '../plugins/json-import.js';
import * as datasetteSource from '../plugins/datasette-source.js';
import * as urlSource from '../plugins/url-source.js';
import * as dumpExport from '../plugins/dump-export.js';
import * as sqlExport from '../plugins/sql-export.js';
import * as gistSync from '../plugins/gist-sync.js';
import * as serverSync from '../plugins/server-sync.js';
import * as newTableButton from '../plugins/new-table-button.js';
import * as coreRenderers from '../plugins/core-renderers.js';
import * as cellColor from '../plugins/cell-color.js';
import * as cellImage from '../plugins/cell-image.js';
import * as htmlPreview from '../plugins/html-preview.js';
import * as htmlRender from '../plugins/html-render.js';
import * as cellLink from '../plugins/cell-link.js';
import * as deleteTable from '../plugins/delete-table.js';
import * as importData from '../plugins/import-data.js';
import * as autoSync from '../plugins/auto-sync.js';
import * as views from '../plugins/views.js';
import * as settings from '../plugins/settings.js';

/** A built-in plugin paired with its id (mirrors `meta.id`, cheaply reachable without importing every module). */
export interface BuiltinEntry {
  id: string;
  meta: NonNullable<PluginModule['meta']>;
  module: PluginModule;
}

/**
 * Built-in plugins shipped with the renderer. They satisfy the same
 * PluginModule contract as URL-loaded plugins; the only difference is the
 * delivery mechanism (static import vs. dynamic import of a Blob URL).
 *
 * Only plugins flagged `meta.fixed = true` are always-on and non-disableable
 * (currently `core-renderers`). Every other built-in is user-toggleable from
 * the Plugin Manager and defaults to enabled. Disabled state is stored in the
 * plugins collection under the synthetic key `builtin:<id>`.
 *
 * The Plugin Manager itself is opened from a core header button (see
 * `app-shell.ts`) — it is not a plugin.
 */
const modules: PluginModule[] = [
  settings,
  newTableButton,
  csvImport,
  jsonImport,
  datasetteSource,
  urlSource,
  csvExport,
  dumpExport,
  sqlExport,
  gistSync,
  serverSync,
  coreRenderers,
  cellColor,
  cellImage,
  htmlPreview,
  htmlRender,
  cellLink,
  deleteTable,
  importData,
  autoSync,
  views,
];

function requireMeta(p: PluginModule): NonNullable<PluginModule['meta']> {
  if (!p.meta) throw new Error('Built-in plugin is missing meta');
  return p.meta;
}

const builtins: BuiltinEntry[] = modules.map((module) => {
  const meta = requireMeta(module);
  return { id: meta.id, meta, module };
});

/** Public for the Plugin Manager dialog so it can render icon/name/id/author/repo. */
export const builtinPlugins = builtins;

/** Synthetic URL used to key built-in disable state in the plugins collection. */
export function builtinKey(id: string): string {
  return `builtin:${id}`;
}

/**
 * Runs init() on every built-in plugin (skipping non-fixed ones the user
 * disabled). Returns a function that runs load() on the same set once the
 * app shell is ready.
 */
export async function loadBuiltinPlugins(api: HostApi): Promise<() => Promise<void>> {
  const active: BuiltinEntry[] = [];
  for (const entry of builtins) {
    if (await isDisabled(api, entry)) continue;
    active.push(entry);
    try {
      await entry.module.init?.(api);
    } catch (err) {
      api.events.emit('plugin:error', {
        url: entry.id,
        phase: 'init',
        error: err,
      });
    }
  }

  return async () => {
    for (const entry of active) {
      try {
        await entry.module.load?.(api);
      } catch (err) {
        api.events.emit('plugin:error', {
          url: entry.id,
          phase: 'load',
          error: err,
        });
      }
    }
  };
}

async function isDisabled(api: HostApi, entry: BuiltinEntry): Promise<boolean> {
  if (entry.meta.fixed) return false;
  const rec = await api.store.plugins.findOne(builtinKey(entry.id));
  return rec?.enabled === false;
}
