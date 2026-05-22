import type {
  ButtonSpec,
  DropHandler,
  ExporterSpec,
  ImporterSpec,
  TableButtonSpec,
  UiRegistry,
  Unregister,
  UrlSourceSpec,
} from '@easydb/shared';

/**
 * Mutable lists the app reads to render header/footer slots and to dispatch
 * drops. Plugins write here via the UiRegistry returned by createUiRegistry.
 */
export interface Registries {
  headerButtons: ButtonSpec[];
  footerButtons: ButtonSpec[];
  tableButtons: TableButtonSpec[];
  importers: ImporterSpec[];
  exporters: ExporterSpec[];
  urlSources: UrlSourceSpec[];
  dropHandlers: DropHandler[];
  cellRenderers: Map<string, string>;
  rowRenderers: Map<string, string>;
  tableRenderers: Map<string, string>;
}

export function createRegistries(): Registries {
  return {
    headerButtons: [],
    footerButtons: [],
    tableButtons: [],
    importers: [],
    exporters: [],
    urlSources: [],
    dropHandlers: [],
    cellRenderers: new Map(),
    rowRenderers: new Map(),
    tableRenderers: new Map(),
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
    registerImporter: (spec) => pushReg(r.importers, spec),
    registerExporter: (spec) => pushReg(r.exporters, spec),
    registerUrlSource: (spec) => pushReg(r.urlSources, spec),
    registerDropHandler: (fn) => pushReg(r.dropHandlers, fn),
    registerCellRenderer: (typeName, tag) => mapReg(r.cellRenderers, typeName, tag),
    registerRowRenderer: (viewName, tag) => mapReg(r.rowRenderers, viewName, tag),
    registerTableRenderer: (viewName, tag) => mapReg(r.tableRenderers, viewName, tag),
    openNewTableDialog: () => {
      document.dispatchEvent(new CustomEvent('easydb:open-new-table'));
    },
  };
}
