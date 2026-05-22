/**
 * RxDB collection schemas. These are JSON Schema documents that RxDB consumes
 * directly. Keep them in sync with the TS types in ./types.ts — the types are
 * the API surface, the schemas are RxDB's runtime validation.
 */

export const workspaceSchema = {
  title: 'workspace',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    name: { type: 'string' },
    createdAt: { type: 'number' },
    pluginUrls: { type: 'array', items: { type: 'string' } },
  },
  required: ['id', 'name', 'createdAt', 'pluginUrls'],
} as const;

export const tableSchema = {
  title: 'table',
  // v1: added ColumnSpec.hidden
  // v2: added ColumnSpec.width
  version: 2,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    workspaceId: { type: 'string', maxLength: 64 },
    name: { type: 'string' },
    code: { type: 'string' },
    columns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string' },
          default: {},
          max: { type: 'number' },
          unique: { type: 'boolean' },
          notnull: { type: 'boolean' },
          hidden: { type: 'boolean' },
          width: { type: 'number' },
        },
        required: ['field', 'label', 'type'],
      },
    },
    view: { type: 'string' },
    windowGeometry: { type: 'object' },
    sortColumn: { type: 'string' },
    sortAsc: { type: 'boolean' },
    filters: { type: 'object' },
    updatedAt: { type: 'number', multipleOf: 1, minimum: 0, maximum: 9999999999999 },
  },
  required: ['id', 'workspaceId', 'name', 'code', 'columns', 'view', 'updatedAt'],
  indexes: ['workspaceId', 'updatedAt'],
} as const;

/**
 * One row collection per table. Created dynamically with name `row_<tableId>`.
 */
export const rowSchema = {
  title: 'row',
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 64 },
    tableId: { type: 'string', maxLength: 64 },
    data: { type: 'object' },
    updatedAt: { type: 'number', multipleOf: 1, minimum: 0, maximum: 9999999999999 },
  },
  required: ['id', 'tableId', 'data', 'updatedAt'],
  indexes: ['tableId', 'updatedAt'],
} as const;

export const settingSchema = {
  title: 'setting',
  version: 0,
  primaryKey: 'key',
  type: 'object',
  properties: {
    key: { type: 'string', maxLength: 128 },
    value: {},
  },
  required: ['key'],
} as const;

export const pluginSchema = {
  title: 'plugin',
  version: 0,
  primaryKey: 'url',
  type: 'object',
  properties: {
    url: { type: 'string', maxLength: 512 },
    enabled: { type: 'boolean' },
    lastFetched: { type: 'number' },
    cachedBody: { type: 'string' },
    lastError: { type: 'string' },
  },
  required: ['url', 'enabled', 'lastFetched'],
} as const;
