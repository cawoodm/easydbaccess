// packages/renderer/src/plugins/datasette-collection.ts
//
// Phase 2c: a live read-write `DataCollection<Row>` backed by a remote Datasette
// table. Registered as a row-source provider (Phase 2a seam) so a Table whose
// `source.type === 'datasette'` routes here instead of Dexie. Reads follow the
// cursor (datasette-client.fetchRows); writes map straight onto the JSON write
// API (insert / update-by-pk / delete-by-pk), authenticated with a device-local
// token. Row identity is the tilde-encoded primary key, so a row's id is exactly
// the URL segment used to update/delete it and stays stable across refetches.

import type {
  DataCollection,
  HostApi,
  Row,
  RowSourceCtx,
  Table,
  Unsubscribe,
  FetchOpts,
} from '@easydb/shared';
import { cryptoUUID } from '../util/ids.js';
import {
  deleteRowByPk,
  fetchRows,
  insertRows,
  rowPk,
  updateRowByPk,
  upsertRows,
  withAuthFetch,
  type DatasetteRef,
} from './datasette-client.js';
import { DEFAULT_CONNECT_MAX_ROWS, getDatasetteSettings } from './datasette-common.js';

/** Thrown when a write is attempted against a table resolved as read-only. */
export class SourceReadOnlyError extends Error {
  constructor(op: string) {
    super(`This Datasette table is read-only — ${op} is not permitted.`);
    this.name = 'SourceReadOnlyError';
  }
}

export interface DatasetteSourceConfig {
  base: string;
  db: string;
  table: string;
  /** Primary-key columns; defaults to ['rowid'] for rowid tables. */
  pks?: string[];
  /** Max rows a single materialisation pulls. */
  maxRows?: number;
  /** Poll interval (ms) for `subscribe`; 0/absent disables polling. */
  pollIntervalMs?: number;
}

/** Device-local settings key holding the bearer token for an instance base. */
export function tokenSettingKey(base: string): string {
  return `datasette:token:${base}`;
}

function matchesQuery(row: Row, query: Partial<Row>): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (k === 'data') continue; // object equality is meaningless here
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

/**
 * Build the live read-write collection for a sourced table. Pure enough to
 * unit-test: all I/O goes through `ctx.backend.fetch` and `ctx.settings`.
 *
 * `api` is optional and used ONLY to resolve the "Datasette" settings tab's
 * `connectMaxRows` when `cfg.maxRows` doesn't already pin it — `RowSourceCtx`
 * carries no layered settings resolver (see its doc comment), so the caller
 * (`datasette-connect.ts`, which has the real `HostApi` at `init` time) passes
 * it through explicitly. Omitting it (as the unit tests do) falls back to
 * {@link DEFAULT_CONNECT_MAX_ROWS}.
 */
export function createDatasetteCollection(
  table: Table,
  ctx: RowSourceCtx,
  api?: HostApi,
): DataCollection<Row> {
  const src = table.source;
  const cfg = (src?.config ?? {}) as unknown as DatasetteSourceConfig;
  const ref: DatasetteRef = { base: cfg.base, db: cfg.db, table: cfg.table, query: {} };
  const pks = Array.isArray(cfg.pks) && cfg.pks.length > 0 ? cfg.pks : ['rowid'];
  const writable = src?.writable === true;
  const explicitMaxRows = cfg.maxRows;
  let maxRowsPromise: Promise<number> | null = null;
  // Resolved once per collection and memoised — `resolveMaxRows` is awaited on
  // every `loadAll`, and the setting can't change mid-session anyway.
  function resolveMaxRows(): Promise<number> {
    if (explicitMaxRows != null) return Promise.resolve(explicitMaxRows);
    if (!maxRowsPromise) {
      maxRowsPromise = api
        ? getDatasetteSettings(api).then((s) => s.connectMaxRows)
        : Promise.resolve(DEFAULT_CONNECT_MAX_ROWS);
    }
    return maxRowsPromise;
  }
  const pollIntervalMs = cfg.pollIntervalMs ?? 0;

  const baseFetch = (u: string, o?: unknown) => ctx.backend.fetch(u, o as never);

  async function token(): Promise<string | undefined> {
    const s = await ctx.settings.findOne(tokenSettingKey(cfg.base));
    const v = s?.value;
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  }

  // Every request (read AND write) carries the device-local bearer token when
  // one is stored — so private instances that require auth to read work too,
  // not only writes. Reads on public instances are unaffected (no token → no
  // header). Resolved per call so a freshly-entered token takes effect.
  const fetchFn = async (u: string, o?: FetchOpts): Promise<Response> =>
    withAuthFetch(baseFetch, await token())(u, o);

  function toRow(data: Record<string, unknown>): Row {
    const id = rowPk(data, pks) ?? cryptoUUID();
    return { id, tableId: table.id, data, updatedAt: Date.now() };
  }

  function requireWritable(op: string): void {
    if (!writable) throw new SourceReadOnlyError(op);
  }

  // Fields we must not send in an `update` body: the primary key(s) address the
  // row (they're in the URL) and Datasette rejects updating them.
  function stripPks(data: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) if (!pks.includes(k)) out[k] = v;
    return out;
  }

  const subscribers = new Set<(rows: Row[]) => void>();
  let cache: Row[] = [];
  let loaded = false;
  let inFlight: Promise<Row[]> | null = null;

  // Materialise all rows, collapsing concurrent callers onto a single request.
  // The grid both subscribes AND calls find() on mount, and other chrome
  // (footer row-count, search) opens the collection too. Without this dedup —
  // and the memoisation in routed-data-store that hands every caller the SAME
  // collection — that becomes a burst of identical row requests. A local import
  // fetches once; a live table must not hammer the instance on every render
  // (datasette.io behind Cloudflare treats the burst as bot traffic and starts
  // blocking it, leaving the grid empty).
  function loadAll(): Promise<Row[]> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const { rows } = await fetchRows(fetchFn, ref, { maxRows: await resolveMaxRows() });
        cache = rows.map(toRow);
        loaded = true;
        for (const fn of subscribers) fn(cache);
        return cache;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    async find(query) {
      const rows = loaded ? cache : await loadAll();
      if (!query || Object.keys(query).length === 0) return rows;
      return rows.filter((r) => matchesQuery(r, query));
    },

    async findOne(id) {
      const rows = loaded ? cache : await loadAll();
      return rows.find((r) => r.id === id) ?? null;
    },

    async insert(doc) {
      requireWritable('insert');
      const [saved] = await insertRows(fetchFn, ref, [doc.data]);
      const row = toRow(saved ?? doc.data);
      ctx.events.emit('row:created', { tableId: table.id, row });
      void loadAll();
      return row;
    },

    async bulkInsert(docs) {
      if (docs.length === 0) return [];
      requireWritable('insert');
      const saved = await insertRows(
        fetchFn,
        ref,
        docs.map((d) => d.data),
      );
      const rows = (saved.length ? saved : docs.map((d) => d.data)).map(toRow);
      void loadAll();
      return rows;
    },

    async upsert(doc) {
      requireWritable('upsert');
      const [saved] = await upsertRows(fetchFn, ref, [doc.data]);
      const row = toRow(saved ?? doc.data);
      void loadAll();
      return row;
    },

    async patch(id, patch) {
      requireWritable('update');
      // The grid patches `{ data: {...fullRow, [field]: value} }`; send the
      // changed columns (minus PKs, which address the row via the URL).
      const nextData = (patch as Partial<Row>).data;
      const changes = stripPks(nextData ?? {});
      const updated = await updateRowByPk(fetchFn, ref, id, changes);
      const row = toRow(updated ?? { ...(nextData ?? {}) });
      ctx.events.emit('row:updated', { tableId: table.id, row, prev: row });
      void loadAll();
      return row;
    },

    async remove(id) {
      requireWritable('delete');
      await deleteRowByPk(fetchFn, ref, id);
      ctx.events.emit('row:deleted', { tableId: table.id, rowId: id });
      void loadAll();
    },

    async bulkRemove(ids) {
      if (ids.length === 0) return;
      requireWritable('delete');
      for (const id of ids) await deleteRowByPk(fetchFn, ref, id);
      void loadAll();
    },

    subscribe(fn): Unsubscribe {
      subscribers.add(fn);
      // Deliver the cache if we already have it; only hit the network when we
      // haven't loaded yet (find() on the same instance shares the request).
      if (loaded) fn(cache);
      else void loadAll();
      let timer: ReturnType<typeof setInterval> | null = null;
      if (pollIntervalMs > 0) timer = setInterval(() => void loadAll(), pollIntervalMs);
      return () => {
        subscribers.delete(fn);
        if (timer) clearInterval(timer);
      };
    },

    // Force a fresh network read (bypassing the `loaded` cache) and notify
    // subscribers — powers the per-table "Refresh" button.
    async refresh() {
      await loadAll();
    },
  };
}
