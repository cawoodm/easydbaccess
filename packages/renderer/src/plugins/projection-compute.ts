// packages/renderer/src/plugins/projection-compute.ts
//
// The pure heart of a Projection (a virtual table / database view / JOIN):
// given a `ProjectionSpec` and the rows of each participating source table,
// compute the derived rows. DOM- and Dexie-free on purpose so the join / filter
// / select / compute semantics are unit-testable in isolation — the provider in
// `projection.ts` is the only thing that touches the store.
//
// See docs/superpowers/specs/2026-07-31-projection-virtual-tables-design.md.

import type { ProjectionColumn, ProjectionSource, ProjectionSpec, Row, Table } from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';

/** Rows of each source table, keyed by the source's `alias`. */
export type SourceRowsByAlias = Record<string, Row[]>;

/** One joined tuple: alias → the contributing source row (undefined on an unmatched left join). */
type Combo = Record<string, Row | undefined>;

/**
 * Compute a projection's rows. Each output row's id is `${baseRowId}#${ordinal}`
 * so a left-join fan-out stays unique yet every row traces back to exactly one
 * base row (that is what makes unambiguous writeback possible).
 */
export function computeProjection(spec: ProjectionSpec, sourceRows: SourceRowsByAlias): Row[] {
  const base = spec.sources[0];
  if (!base) return [];
  const baseRows = sourceRows[base.alias] ?? [];

  // Build the join, starting from the base rows and folding in each JOIN source.
  let combos: Combo[] = baseRows.map((r) => ({ [base.alias]: r }));
  for (let i = 1; i < spec.sources.length; i++) {
    const src = spec.sources[i];
    if (!src) continue;
    const rows = sourceRows[src.alias] ?? [];
    const join = src.join;
    const next: Combo[] = [];
    for (const combo of combos) {
      const matches = join
        ? rows.filter((r) => join.on.every((k) => keyEqual(r.data[k.field], combo[k.eqAlias]?.data[k.eqField])))
        : [];
      if (matches.length > 0) {
        for (const m of matches) next.push({ ...combo, [src.alias]: m });
      } else if (join?.type === 'left') {
        next.push({ ...combo, [src.alias]: undefined });
      }
      // inner join with no match: the combo is dropped.
    }
    combos = next;
  }

  const result: Row[] = [];
  const ordinalByBase = new Map<string, number>();
  for (const combo of combos) {
    const baseRow = combo[base.alias];
    if (!baseRow) continue; // base is always present
    const data = buildRowData(spec.columns, combo);
    if (!passesFilters(data, spec.filters)) continue;
    const ordinal = ordinalByBase.get(baseRow.id) ?? 0;
    ordinalByBase.set(baseRow.id, ordinal + 1);
    result.push({
      id: `${baseRow.id}#${ordinal}`,
      tableId: '', // stamped with the projection's id by the `rows()` store view
      data,
      updatedAt: maxUpdatedAt(combo),
    });
  }
  return result;
}

/**
 * Build one output row's data. Two passes so a computed (`script`) column can
 * reference the already-selected source columns by their OUTPUT field name via
 * its `row` argument — the same `function render(row)` convention as a column's
 * `script`.
 */
function buildRowData(columns: ProjectionColumn[], combo: Combo): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const col of columns) {
    if (col.from.kind === 'source') data[col.field] = combo[col.from.alias]?.data[col.from.field];
  }
  for (const col of columns) {
    if (col.from.kind === 'script') {
      const run = runColumnScript(col.from.script, data);
      data[col.field] = run.ok ? run.value : undefined;
    }
  }
  return data;
}

/**
 * Join-key equality. SQL semantics: a null/undefined key never matches. Values
 * of differing primitive types compare by their string form, so a numeric id in
 * one table matches a string id in another (common with CSV-imported data).
 */
function keyEqual(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return false;
  if (a === b) return true;
  if (typeof a !== 'object' && typeof b !== 'object') return String(a) === String(b);
  return false;
}

/** Existing filter semantics: case-insensitive substring per output field, ANDed. */
function passesFilters(data: Record<string, unknown>, filters: ProjectionSpec['filters']): boolean {
  if (!filters) return true;
  for (const [field, needle] of Object.entries(filters)) {
    if (!needle) continue;
    const hay = data[field];
    const text = hay == null ? '' : String(hay);
    if (!text.toLowerCase().includes(needle.toLowerCase())) return false;
  }
  return true;
}

function maxUpdatedAt(combo: Combo): number {
  let max = 0;
  for (const r of Object.values(combo)) if (r && r.updatedAt > max) max = r.updatedAt;
  return max;
}

/**
 * The output fields that can be written back: a `source` column bound to the
 * BASE source. Secondary-source columns (join fan-out / null) and computed
 * columns are read-only. Used both to compile `ColumnSpec.readonly` at save time
 * and to gate writes at runtime.
 */
export function resolveWritability(spec: ProjectionSpec): Set<string> {
  const baseAlias = spec.sources[0]?.alias;
  const writable = new Set<string>();
  if (!baseAlias) return writable;
  for (const col of spec.columns) {
    if (col.from.kind === 'source' && col.from.alias === baseAlias) writable.add(col.field);
  }
  return writable;
}

// -- Cycle detection -------------------------------------------------------

/** Resolve a spec source to a table: by name, with `tableId` as a hint only. */
function resolveSource(
  s: ProjectionSource,
  byId: Map<string, Table>,
  byName: Map<string, Table>,
): Table | undefined {
  if (s.tableId) {
    const hit = byId.get(s.tableId);
    if (hit && hit.name === s.tableName) return hit;
  }
  return byName.get(s.tableName);
}

/**
 * True when following `rootId`'s projection sources leads back to a table
 * already on the path — a chain that could never terminate.
 *
 * This walks the SPEC GRAPH rather than any runtime "currently computing" state,
 * so the answer depends only on how the projections are defined. That matters:
 * an ambient in-flight flag cannot tell a genuine cycle from two ordinary
 * concurrent reads of the same projection, and mistaking one for the other
 * publishes a spurious empty result.
 */
export function hasProjectionCycle(rootId: string, tables: Table[]): boolean {
  const byId = new Map(tables.map((t) => [t.id, t] as const));
  const byName = new Map<string, Table>();
  for (const t of tables) if (!byName.has(t.name)) byName.set(t.name, t);

  const walk = (id: string, path: Set<string>): boolean => {
    if (path.has(id)) return true;
    const t = byId.get(id);
    if (t?.source?.type !== 'projection') return false; // a plain table ends the chain
    const spec = t.source.config as unknown as ProjectionSpec | undefined;
    if (!spec || !Array.isArray(spec.sources)) return false;
    const next = new Set(path).add(id);
    for (const s of spec.sources) {
      const src = resolveSource(s, byId, byName);
      if (src && walk(src.id, next)) return true;
    }
    return false;
  };
  return walk(rootId, new Set());
}

// -- Join-key guessing (editor convenience) -------------------------------

/** One already-introduced source, for scoring a new source's join against it. */
export interface JoinColumnsRef {
  alias: string;
  tableName: string;
  fields: string[];
}

/** A preselected equijoin: this new source's `thisField` = `otherAlias`.`otherField`. */
export interface GuessedJoin {
  thisField: string;
  otherAlias: string;
  otherField: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const singular = (s: string): string => (s.endsWith('s') && s.length > 1 ? s.slice(0, -1) : s);

/**
 * Score how likely two fields form a join key (0 = no signal). Recognises:
 *  - a shared foreign-key-shaped column on both sides (`customerId` = `customerId`),
 *  - the classic FK convention: one side `id`, the other `<thatTable>Id`
 *    (`Dept.id` = `People.deptId`).
 * A bare `id` = `id` scores 0 — joining unrelated tables on `id` is almost
 * always wrong, so we would rather not preselect it.
 */
function scoreJoinPair(nf: string, nTable: string, ef: string, eTable: string): number {
  const n = norm(nf);
  const e = norm(ef);
  if (!n || !e) return 0;
  if (n === e) {
    if (n === 'id') return 0;
    return n.endsWith('id') ? 9 : 7; // shared "customerId" strong; shared "name" plausible
  }
  // fk(idField, idTable, fkField): idField is a table's `id`, fkField a
  // `<idTable>Id`-shaped reference to it on the other side.
  const fk = (idField: string, idTable: string, fkField: string): number => {
    if (idField !== 'id') return 0;
    if (!fkField.endsWith('id') || fkField.length <= 2) return 0;
    const prefix = fkField.slice(0, -2); // "deptid" -> "dept"
    const t = norm(idTable);
    if (prefix === t || prefix === singular(t) || singular(prefix) === singular(t)) return 9;
    return 5; // "somethingId" vs "id" with no table-name match — weaker
  };
  return Math.max(fk(n, nTable, e), fk(e, eTable, n));
}

/**
 * Guess the equijoin keys for a newly-added source against the already-chosen
 * ones, so the editor preselects sensible fields instead of blanks. Returns the
 * highest-scoring pair, or null when nothing looks like a key.
 */
export function guessJoinKeys(
  newSource: { tableName: string; fields: string[] },
  earlierSources: JoinColumnsRef[],
): GuessedJoin | null {
  let best: GuessedJoin | null = null;
  let bestScore = 0;
  for (const es of earlierSources) {
    for (const nf of newSource.fields) {
      for (const ef of es.fields) {
        const s = scoreJoinPair(nf, newSource.tableName, ef, es.tableName);
        if (s > bestScore) {
          bestScore = s;
          best = { thisField: nf, otherAlias: es.alias, otherField: ef };
        }
      }
    }
  }
  return best;
}

/** Where a base-source cell edit is written, or null when the column is read-only. */
export interface WritebackTarget {
  /** Base source row id (parsed from the `${baseRowId}#${ordinal}` output id). */
  baseRowId: string;
  /** The stored field on the base row (the source field, not the output field). */
  field: string;
}

/**
 * Resolve an edit to output cell (`rowId`, `field`) to its base-row write
 * target, or null when the column cannot be written back.
 */
export function writebackTarget(
  spec: ProjectionSpec,
  rowId: string,
  field: string,
): WritebackTarget | null {
  if (!resolveWritability(spec).has(field)) return null;
  const col = spec.columns.find((c) => c.field === field);
  if (!col || col.from.kind !== 'source') return null;
  const hash = rowId.lastIndexOf('#');
  const baseRowId = hash >= 0 ? rowId.slice(0, hash) : rowId;
  return { baseRowId, field: col.from.field };
}
