export type ColumnType = 'string' | 'number' | 'date' | 'boolean' | 'color' | 'image';

export interface ColumnSpec {
  field: string;
  label: string;
  type: ColumnType;
  default?: unknown;
  max?: number;
  unique?: boolean;
  notnull?: boolean;
  /** When true, the column is excluded from the rendered table (data preserved). */
  hidden?: boolean;
}

export interface WindowGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimized: boolean;
  maximized: boolean;
}

export interface Workspace {
  id: string;
  name: string;
  createdAt: number;
  pluginUrls: string[];
}

export interface Table {
  id: string;
  workspaceId: string;
  name: string;
  code: string;
  columns: ColumnSpec[];
  view: string;
  windowGeometry?: WindowGeometry | undefined;
  sortColumn?: string | undefined;
  sortAsc?: boolean | undefined;
  filters?: Record<string, string> | undefined;
  updatedAt: number;
}

export interface Row {
  id: string;
  tableId: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface PluginRecord {
  url: string;
  enabled: boolean;
  lastFetched: number;
  cachedBody?: string;
  lastError?: string;
}
