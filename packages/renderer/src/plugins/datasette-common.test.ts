import { describe, expect, it } from 'vitest';
import type { HostApi, RegisteredSettings, SettingsFieldSpec } from '@easydb/shared';
import {
  DATASETTE_SETTINGS_ID,
  DEFAULT_CONNECT_MAX_ROWS,
  DEFAULT_MAX_IMPORT_ROWS,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RETRY_WAIT_SECONDS,
  getDatasetteSettings,
  importRowCap,
  registerDatasetteSettings,
} from './datasette-common.js';

/** A fake HostApi exposing only what registerDatasetteSettings/getDatasetteSettings touch. */
function makeApi(stored: Record<string, unknown> = {}) {
  const registered = new Map<string, RegisteredSettings>();
  const api = {
    ui: {
      registerSettings: (pluginId: string, name: string, fields: SettingsFieldSpec[]) => {
        registered.set(pluginId, { name, fields });
        return () => registered.delete(pluginId);
      },
    },
    settings: {
      get<T>(pluginId: string, key: string): Promise<T | undefined> {
        return Promise.resolve(stored[`${pluginId}:${key}`] as T | undefined);
      },
    },
  } as unknown as HostApi;
  return { api, registered };
}

describe('registerDatasetteSettings', () => {
  it('registers one "Datasette" tab with all four fields', () => {
    const { api, registered } = makeApi();
    registerDatasetteSettings(api);
    const tab = registered.get(DATASETTE_SETTINGS_ID);
    expect(tab?.name).toBe('Datasette');
    expect(tab?.fields.map((f) => f.key)).toEqual([
      'maxImportRows',
      'pageSize',
      'connectMaxRows',
      'retryWaitSeconds',
    ]);
  });

  it('registering twice (both plugins calling it) leaves one identical tab', () => {
    const { api, registered } = makeApi();
    registerDatasetteSettings(api);
    const first = registered.get(DATASETTE_SETTINGS_ID);
    registerDatasetteSettings(api);
    const second = registered.get(DATASETTE_SETTINGS_ID);
    expect(registered.size).toBe(1);
    expect(second).toEqual(first);
    expect(second?.fields.map((f) => f.key)).toEqual([
      'maxImportRows',
      'pageSize',
      'connectMaxRows',
      'retryWaitSeconds',
    ]);
  });
});

describe('getDatasetteSettings', () => {
  it('falls back to defaults when nothing is stored', async () => {
    const { api } = makeApi();
    await expect(getDatasetteSettings(api)).resolves.toEqual({
      maxImportRows: DEFAULT_MAX_IMPORT_ROWS,
      pageSize: DEFAULT_PAGE_SIZE,
      connectMaxRows: DEFAULT_CONNECT_MAX_ROWS,
      retryWaitSeconds: DEFAULT_RETRY_WAIT_SECONDS,
    });
  });

  it('reads stored values, floored to integers', async () => {
    const { api } = makeApi({
      'datasette:maxImportRows': 500.7,
      'datasette:pageSize': 200,
      'datasette:connectMaxRows': 2000,
      'datasette:retryWaitSeconds': 30,
    });
    await expect(getDatasetteSettings(api)).resolves.toEqual({
      maxImportRows: 500,
      pageSize: 200,
      connectMaxRows: 2000,
      retryWaitSeconds: 30,
    });
  });

  it('maxImportRows: 0 is a valid, honoured value (unlimited)', async () => {
    const { api } = makeApi({ 'datasette:maxImportRows': 0 });
    const s = await getDatasetteSettings(api);
    expect(s.maxImportRows).toBe(0);
  });

  it('rejects a negative maxImportRows, falling back to the default', async () => {
    const { api } = makeApi({ 'datasette:maxImportRows': -5 });
    const s = await getDatasetteSettings(api);
    expect(s.maxImportRows).toBe(DEFAULT_MAX_IMPORT_ROWS);
  });

  it('rejects non-finite / non-numeric values, falling back to the default', async () => {
    const { api } = makeApi({
      'datasette:pageSize': NaN,
      'datasette:connectMaxRows': 'not a number',
      'datasette:retryWaitSeconds': Infinity,
    });
    const s = await getDatasetteSettings(api);
    expect(s.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(s.connectMaxRows).toBe(DEFAULT_CONNECT_MAX_ROWS);
    expect(s.retryWaitSeconds).toBe(DEFAULT_RETRY_WAIT_SECONDS);
  });

  it('rejects a zero or negative value for the non-unlimited fields', async () => {
    const { api } = makeApi({
      'datasette:pageSize': 0,
      'datasette:connectMaxRows': -1,
      'datasette:retryWaitSeconds': 0,
    });
    const s = await getDatasetteSettings(api);
    expect(s.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(s.connectMaxRows).toBe(DEFAULT_CONNECT_MAX_ROWS);
    expect(s.retryWaitSeconds).toBe(DEFAULT_RETRY_WAIT_SECONDS);
  });
});

describe('importRowCap', () => {
  it('maps 0 (unlimited) to Number.MAX_SAFE_INTEGER for paging arithmetic', () => {
    expect(importRowCap(0)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('passes any positive cap through unchanged', () => {
    expect(importRowCap(5000)).toBe(5000);
  });
});
