import type {
  ColumnEditorActionSpec,
  ButtonSpec,
  CommandSpec,
  ConnectorSpec,
  Dialogs,
  DropHandler,
  ExporterSpec,
  ImporterSpec,
  RegisteredSettings,
  RowCollectionProvider,
  SettingsFieldSpec,
  TableButtonSpec,
  UiRegistry,
  Unregister,
  UrlSourceSpec,
} from '@easydb/shared';
import { HostDialogs } from '../dialogs/host-dialogs.js';
import { ToastHost } from '../dialogs/toast-host.js';

/**
 * Mutable lists the app reads to render header/footer slots and to dispatch
 * drops. Plugins write here via the UiRegistry returned by createUiRegistry.
 *
 * `cellRenderers` is keyed by renderer NAME (the value a column puts in its
 * `renderer` field), not by column type. Names are arbitrary plugin-chosen
 * strings — 'color', 'image', 'link', 'date', etc.
 */
export interface Registries {
  headerButtons: ButtonSpec[];
  footerButtons: ButtonSpec[];
  tableButtons: TableButtonSpec[];
  /** Buttons the column editor shows above its column list. */
  columnEditorActions: ColumnEditorActionSpec[];
  importers: ImporterSpec[];
  /** Live-backend connectors listed by the Connect menu. */
  connectors: ConnectorSpec[];
  exporters: ExporterSpec[];
  urlSources: UrlSourceSpec[];
  dropHandlers: DropHandler[];
  cellRenderers: Map<string, string>;
  rowRenderers: Map<string, string>;
  tableRenderers: Map<string, string>;
  /** Row-collection providers keyed by `RowCollectionProvider.type`. */
  rowSources: Map<string, RowCollectionProvider>;
  /** Plugin settings tabs keyed by pluginId, in registration (insertion) order. */
  settings: Map<string, RegisteredSettings>;
  /** Commands surfaced in the Ctrl+K command palette, in registration order. */
  commands: CommandSpec[];
}

export function createRegistries(): Registries {
  return {
    headerButtons: [],
    footerButtons: [],
    tableButtons: [],
    columnEditorActions: [],
    importers: [],
    connectors: [],
    exporters: [],
    urlSources: [],
    dropHandlers: [],
    cellRenderers: new Map(),
    rowRenderers: new Map(),
    tableRenderers: new Map(),
    rowSources: new Map(),
    settings: new Map(),
    commands: [],
  };
}

function pushReg<T>(list: T[], item: T): Unregister {
  list.push(item);
  return () => {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
  };
}

function mapReg<K>(map: Map<K, string>, key: K, value: string): Unregister {
  map.set(key, value);
  return () => {
    if (map.get(key) === value) map.delete(key);
  };
}

export function createUiRegistry(r: Registries): UiRegistry {
  return {
    registerHeaderButton: (spec) => pushReg(r.headerButtons, spec),
    registerFooterButton: (spec) => pushReg(r.footerButtons, spec),
    registerTableButton: (spec) => pushReg(r.tableButtons, spec),
    registerColumnEditorAction: (spec) => pushReg(r.columnEditorActions, spec),
    registerImporter: (spec) => pushReg(r.importers, spec),
    registerConnector: (spec) => pushReg(r.connectors, spec),
    registerExporter: (spec) => pushReg(r.exporters, spec),
    registerUrlSource: (spec) => pushReg(r.urlSources, spec),
    registerDropHandler: (fn) => pushReg(r.dropHandlers, fn),
    registerCellRenderer: (name, tag) => mapReg(r.cellRenderers, name, tag),
    registerRowRenderer: (viewName, tag) => mapReg(r.rowRenderers, viewName, tag),
    registerTableRenderer: (viewName, tag) => mapReg(r.tableRenderers, viewName, tag),
    openNewTableDialog: () => {
      document.dispatchEvent(new CustomEvent('easydb:open-new-table'));
    },
    openCsvPasteDialog: () => {
      document.dispatchEvent(new CustomEvent('easydb:open-csv-paste'));
    },
    openPluginManager: () => {
      document.dispatchEvent(new CustomEvent('easydb:open-plugin-manager'));
    },
    openSettings: () => {
      document.dispatchEvent(new CustomEvent('easydb:open-settings'));
    },
    registerCommand: (spec) => pushReg(r.commands, spec),
    openCommandPalette: () => {
      document.dispatchEvent(new CustomEvent('easydb:open-command-palette'));
    },
    registerSettings: (pluginId: string, name: string, fields: SettingsFieldSpec[]) => {
      r.settings.set(pluginId, { name, fields });
      return () => {
        if (r.settings.get(pluginId)?.name === name) r.settings.delete(pluginId);
      };
    },
    dialogs: hostDialogsProxy,
  };
}

/**
 * Lazy proxy that resolves the singleton <host-dialogs> instance at call time.
 * Plugins receive this proxy in `init(api)` BEFORE the shell has rendered, so
 * we can't capture the instance eagerly — we look it up on each invocation.
 * If the host is somehow gone, we fall back to the native window primitives
 * so plugins never crash mid-flow.
 */
const hostDialogsProxy: Dialogs = {
  async alert(message, title) {
    const h = HostDialogs.instance;
    if (h) return h.alert(message, title);
    window.alert(message);
  },
  async confirm(message, title) {
    const h = HostDialogs.instance;
    if (h) return h.confirm(message, title);
    return window.confirm(message);
  },
  async prompt(message, defaultValue, title) {
    const h = HostDialogs.instance;
    if (h) return h.prompt(message, defaultValue, title);
    return window.prompt(message, defaultValue) ?? null;
  },
  async choice(message, options, title) {
    const h = HostDialogs.instance;
    if (h) return h.choice(message, options, title);
    const picked = window.prompt(`${message}\n\nOptions: ${options.join(', ')}`);
    return picked && options.includes(picked) ? picked : null;
  },
  toast(message, opts) {
    const t = ToastHost.instance;
    if (t) {
      t.show(message, opts);
    } else {
      // Fallback if the chrome hasn't mounted yet — log so plugins don't lose info.
      // eslint-disable-next-line no-console
      console.log(`[toast:${opts?.kind ?? 'info'}]`, opts?.title ?? '', message);
    }
  },
};
