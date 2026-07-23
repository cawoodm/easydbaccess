import { describe, expect, it, vi } from 'vitest';
import type {
  DataCollection,
  DataStore,
  Row,
  RowCollectionProvider,
  RowSourceCtx,
  Table,
} from '@easydb/shared';
import { createRoutedDataStore } from './routed-data-store.js';

/** A stand-in row collection we only ever compare by identity/label. */
function fakeCollection(label: string): DataCollection<Row> {
  return { label } as unknown as DataCollection<Row>;
}

/** Minimal base store that records every `rows()` call and tags its result. */
function makeBaseStore(): { store: DataStore; rowsCalls: string[] } {
  const rowsCalls: string[] = [];
  const passthrough = {
    workspaces: fakeCollection('workspaces'),
    tables: fakeCollection('tables'),
    settings: fakeCollection('settings'),
    plugins: fakeCollection('plugins'),
  };
  const store = {
    ...passthrough,
    rows(tableId: string) {
      rowsCalls.push(tableId);
      return fakeCollection(`local:${tableId}`);
    },
  } as unknown as DataStore;
  return { store, rowsCalls };
}

const ctx = {
  backend: {},
  events: {},
  settings: {},
  workspaceId: () => 'ws',
} as unknown as RowSourceCtx;

function localTable(id: string): Table {
  return { id, workspaceId: 'ws', name: id, code: id, columns: [], view: 'table', updatedAt: 0 };
}
function sourcedTable(id: string, type: string): Table {
  return { ...localTable(id), source: { type, config: { db: 'd', table: 't' } } };
}

function labelOf(coll: DataCollection<Row>): string {
  return (coll as unknown as { label: string }).label;
}

describe('createRoutedDataStore', () => {
  it('is a no-op for local tables (no source) — delegates to base.rows', () => {
    const { store: base, rowsCalls } = makeBaseStore();
    const provider: RowCollectionProvider = { type: 'datasette', create: vi.fn() };
    const providers = new Map([[provider.type, provider]]);
    const routed = createRoutedDataStore({
      base,
      providers,
      tableById: (id) => (id === 't1' ? localTable('t1') : undefined),
      ctx,
    });

    const coll = routed.rows('t1');

    expect(labelOf(coll)).toBe('local:t1');
    expect(rowsCalls).toEqual(['t1']);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('falls back to base.rows when the table is not in the cache', () => {
    const { store: base, rowsCalls } = makeBaseStore();
    const provider: RowCollectionProvider = { type: 'datasette', create: vi.fn() };
    const routed = createRoutedDataStore({
      base,
      providers: new Map([[provider.type, provider]]),
      tableById: () => undefined, // cache miss
      ctx,
    });

    const coll = routed.rows('missing');

    expect(labelOf(coll)).toBe('local:missing');
    expect(rowsCalls).toEqual(['missing']);
    expect(provider.create).not.toHaveBeenCalled();
  });

  it('routes sourced tables to the registered provider, with the table + ctx', () => {
    const { store: base, rowsCalls } = makeBaseStore();
    const remoteColl = fakeCollection('remote:t2');
    const create = vi.fn(() => remoteColl);
    const provider: RowCollectionProvider = { type: 'datasette', create };
    const table = sourcedTable('t2', 'datasette');
    const routed = createRoutedDataStore({
      base,
      providers: new Map([[provider.type, provider]]),
      tableById: (id) => (id === 't2' ? table : undefined),
      ctx,
    });

    const coll = routed.rows('t2');

    expect(coll).toBe(remoteColl);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(table, ctx);
    expect(rowsCalls).toEqual([]); // base.rows never touched for a routed table
  });

  it('falls back to base.rows when the source type has no registered provider', () => {
    const { store: base, rowsCalls } = makeBaseStore();
    const routed = createRoutedDataStore({
      base,
      providers: new Map(), // nothing registered
      tableById: () => sourcedTable('t3', 'datasette'),
      ctx,
    });

    const coll = routed.rows('t3');

    expect(labelOf(coll)).toBe('local:t3');
    expect(rowsCalls).toEqual(['t3']);
  });

  it('passes every non-rows collection straight through to the base store', () => {
    const { store: base } = makeBaseStore();
    const routed = createRoutedDataStore({
      base,
      providers: new Map(),
      tableById: () => undefined,
      ctx,
    });

    expect(routed.workspaces).toBe(base.workspaces);
    expect(routed.tables).toBe(base.tables);
    expect(routed.settings).toBe(base.settings);
    expect(routed.plugins).toBe(base.plugins);
  });
});
