// packages/renderer/src/plugins/projection-collection.ts
//
// The live row collection behind a Projection (a virtual table / view / JOIN).
// A Table carrying `source: { type: 'projection', config: ProjectionSpec }`
// routes its rows here instead of the local database. This factory resolves the spec's
// source tables (by name), reads their rows through the captured store, and
// runs the pure `computeProjection` pipeline — re-running whenever any source
// table changes so the projection stays live.
//
// Writeback: an edit is accepted only for a base-source, non-computed column
// (see `writebackTarget`); it is written to the underlying base row, whose
// change flows back through the subscriptions and recomputes the projection.
//
// The provider is created from the projection PLUGIN's `init(api)`, so it
// closes over `api.store` (the routed store — hence projection-on-projection
// composes) and needs nothing store-related from `RowSourceCtx`.

import type { DataCollection, DataStore, ProjectionSpec, Row, Table, Unsubscribe } from '@easydb/shared';
import { computeProjectionRows, hasProjectionCycle, projectionSourceFields, writebackTarget, type SourceRowsByAlias, type RowProvenance } from './projection-compute.js';
import { readRows } from '../db/row-reader.js';

/** Thrown when a write is attempted against a read-only projection cell. */
export class ProjectionReadOnlyError extends Error {
  constructor(detail = 'this cell is derived') {
    super(`Projection is read-only — ${detail}. Edit a base-table column, or import a copy.`);
    this.name = 'ProjectionReadOnlyError';
  }
}

function parseSpec(config: unknown): ProjectionSpec {
  const spec = config as Partial<ProjectionSpec> | undefined;
  if (!spec || !Array.isArray(spec.sources) || !Array.isArray(spec.columns)) {
    return { version: 1, sources: [], columns: [] };
  }
  return spec as ProjectionSpec;
}

function matchesQuery(row: Row, query: Partial<Row>): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (k === 'data') continue;
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

export function createProjectionCollection(store: DataStore, table: Table): DataCollection<Row> {
  const spec = parseSpec(table.source?.config);

  const subscribers = new Set<(rows: Row[]) => void>();
  let cache: Row[] = [];
  /** Kept in lockstep with `cache`: which source row fed each computed row. */
  let provenance = new Map<string, RowProvenance>();
  let loaded = false;
  let inFlight: Promise<Row[]> | null = null;
  const sourceSubs = new Map<string, Unsubscribe>(); // source tableId → unsubscribe
  let tablesSub: Unsubscribe | null = null;
  let queued = false;

  /**
   * alias → the id of the table that source currently NAMES.
   *
   * Re-derived from the live table list on every run rather than remembered:
   * a source table that is deleted and re-imported comes back under the same
   * name with a different id, and this projection must follow it there.
   */
  function mapSourceIds(all: Table[]): Map<string, string> {
    const byName = new Map<string, Table>();
    for (const t of all) if (!byName.has(t.name)) byName.set(t.name, t);
    const map = new Map<string, string>();
    for (const s of spec.sources) {
      const resolved = byName.get(s.tableName);
      if (resolved) map.set(s.alias, resolved.id);
    }
    return map;
  }

  async function resolveSourceTableIds(): Promise<Map<string, string>> {
    return mapSourceIds(await store.tables.find({ workspaceId: table.workspaceId }));
  }

  async function compute(): Promise<{ rows: Row[]; provenance: Map<string, RowProvenance> }> {
    const all = await store.tables.find({ workspaceId: table.workspaceId });
    // A cycle is a property of how the projections are DEFINED, so it is decided
    // from the spec graph. (An ambient "already computing" flag cannot tell a
    // real cycle from two ordinary concurrent reads, and guessing wrong would
    // publish an empty result for a perfectly good projection.)
    const empty = { rows: [] as Row[], provenance: new Map<string, RowProvenance>() };
    if (hasProjectionCycle(table.id, all)) return empty;
    const ids = mapSourceIds(all);
    const byId = new Map(all.map((t) => [t.id, t] as const));
    // Only the fields the join and the SELECT actually read. A projection holds
    // no rows of its own, so every open recomputes from the sources — and it was
    // reading them whole, all forty columns of each, to use three.
    const needed = projectionSourceFields(spec);
    const sourceRows: SourceRowsByAlias = {};
    for (const s of spec.sources) {
      const tid = ids.get(s.alias);
      if (!tid) return empty; // a source table is missing → render empty
      const fields = needed[s.alias] ?? [];
      const page = await readRows(store.rows(tid), {
        columns: byId.get(tid)?.columns ?? [],
        // No fields at all would mean "every column" to the store, which is the
        // opposite of what an unused source needs. Ask for one, and the ids that
        // come with every row are what the join has to work with anyway.
        fields: fields.length > 0 ? fields : ['id'],
      });
      sourceRows[s.alias] = page.rows;
    }
    const computed = computeProjectionRows(spec, sourceRows);
    return {
      rows: computed.rows.map((r) => ({ ...r, tableId: table.id })),
      provenance: computed.provenance,
    };
  }

  /** Recompute and adopt the result as the cache. */
  async function recompute(): Promise<Row[]> {
    const { rows, provenance: from } = await compute();
    cache = rows;
    // Replaced together — a write resolved against provenance from a previous
    // generation would point at a row this one no longer shows.
    provenance = from;
    loaded = true;
    return rows;
  }

  /**
   * First read: collapse concurrent callers onto ONE compute. The grid both
   * `find()`s and `subscribe()`s in the same tick, so without this the same
   * projection would be computed twice on open.
   */
  function loadAll(): Promise<Row[]> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        return await recompute();
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  /** (Re)subscribe to exactly the current set of source tables' row streams. */
  async function refreshSubscriptions(): Promise<void> {
    const ids = await resolveSourceTableIds();
    const wanted = new Set(ids.values());
    for (const [tid, unsub] of sourceSubs) {
      if (!wanted.has(tid)) {
        unsub();
        sourceSubs.delete(tid);
      }
    }
    for (const tid of wanted) {
      if (!sourceSubs.has(tid)) {
        // `watch` when the store offers it: the rows it would hand `subscribe`
        // are thrown away here — a change means recompute, and the recompute
        // does its own narrow read.
        const coll = store.rows(tid);
        sourceSubs.set(tid, coll.watch ? coll.watch(scheduleRecompute) : coll.subscribe(scheduleRecompute));
      }
    }
  }

  function scheduleRecompute(): void {
    if (queued) return;
    queued = true;
    queueMicrotask(async () => {
      queued = false;
      await refreshSubscriptions();
      // The very first delivery may share an in-flight `find()`; a recompute
      // triggered by a CHANGE must not reuse a snapshot that predates it.
      const rows = loaded ? await recompute() : await loadAll();
      for (const fn of subscribers) fn(rows);
    });
  }

  /**
   * Two cells count as unchanged when they LOOK the same. A grid sends the whole
   * row back on every edit, and its inputs hand back strings, so `1` arriving as
   * `'1'` is not an edit — treating it as one would reject writes that changed
   * nothing.
   */
  function sameCell(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    return String(a) === String(b);
  }

  /**
   * Apply a cell edit to the source row the value actually came from.
   *
   * A patch carries the WHOLE row, not just the edited cell, so the fields are
   * split three ways: unchanged ones are ignored, changed-and-writable ones are
   * grouped by the source they belong to and written, and a changed field with
   * nowhere to go THROWS. That last part is the point — it used to fall through
   * `continue`, so editing a joined column wrote the base row's unchanged values
   * and reported success while the edit itself vanished.
   */
  async function writeBack(rowId: string, data: Record<string, unknown>): Promise<Row> {
    // Provenance lives beside the cache, so the rows must be computed before an
    // edit can be traced back to them.
    if (!loaded) await loadAll();
    const before = cache.find((r) => r.id === rowId)?.data;
    const from = provenance.get(rowId);

    /** alias → { rowId, updates } */
    const byAlias = new Map<string, { rowId: string; updates: Record<string, unknown> }>();
    const rejected: string[] = [];
    for (const [outField, value] of Object.entries(data)) {
      if (before && sameCell(before[outField], value)) continue;
      const target = writebackTarget(spec, rowId, outField, from);
      if (!target) {
        rejected.push(outField);
        continue;
      }
      const entry = byAlias.get(target.alias) ?? { rowId: target.rowId, updates: {} };
      entry.updates[target.field] = value;
      byAlias.set(target.alias, entry);
    }

    if (rejected.length > 0) throw new ProjectionReadOnlyError(reasonFor(rejected, from));
    if (byAlias.size === 0) return { id: rowId, tableId: table.id, data, updatedAt: Date.now() };

    const ids = await resolveSourceTableIds();
    for (const [alias, { rowId: sourceRowId, updates }] of byAlias) {
      const tableId = ids.get(alias);
      if (!tableId) throw new ProjectionReadOnlyError(`the "${sourceName(alias)}" table is not available`);
      const coll = store.rows(tableId);
      const existing = await coll.findOne(sourceRowId);
      if (!existing) throw new ProjectionReadOnlyError('the underlying row no longer exists');
      await coll.patch(sourceRowId, { data: { ...existing.data, ...updates }, updatedAt: Date.now() });
    }
    return { id: rowId, tableId: table.id, data, updatedAt: Date.now() };
  }

  /** The spec's table name for an alias, for a message the user can act on. */
  function sourceName(alias: string): string {
    return spec.sources.find((s) => s.alias === alias)?.tableName ?? alias;
  }

  /** Why these fields could not be written — computed, or an empty join side. */
  function reasonFor(fields: string[], from: RowProvenance | undefined): string {
    const field = fields[0]!;
    const col = spec.columns.find((c) => c.field === field);
    if (!col || col.from.kind === 'script') {
      return `"${field}" is computed by a script, so there is no cell to save it in`;
    }
    if (from && !from[col.from.alias]) {
      return `this row has no matching "${sourceName(col.from.alias)}" row, so there is nowhere to save "${field}"`;
    }
    return `"${field}" cannot be written back to its source`;
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
    async insert() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    async bulkInsert() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    async upsert(doc) {
      return writeBack(doc.id, doc.data);
    },
    async patch(id, patch) {
      if (!patch.data) throw new ProjectionReadOnlyError('a cell edit must carry row data');
      return writeBack(id, patch.data);
    },
    async remove() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    async bulkRemove() {
      throw new ProjectionReadOnlyError('rows are derived from other tables');
    },
    subscribe(fn): Unsubscribe {
      subscribers.add(fn);
      if (!tablesSub) tablesSub = store.tables.subscribe(scheduleRecompute);
      if (loaded) fn(cache);
      else scheduleRecompute();
      return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) {
          tablesSub?.();
          tablesSub = null;
          for (const unsub of sourceSubs.values()) unsub();
          sourceSubs.clear();
          loaded = false;
        }
      };
    },
    async refresh() {
      await refreshSubscriptions();
      const rows = await recompute();
      for (const fn of subscribers) fn(rows);
    },
  };
}
