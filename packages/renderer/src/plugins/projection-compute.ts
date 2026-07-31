// packages/renderer/src/plugins/projection-compute.ts
//
// The pure heart of a Projection (a virtual table / database view / JOIN):
// given a `ProjectionSpec` and the rows of each participating source table,
// compute the derived rows. DOM- and Dexie-free on purpose so the join / filter
// / select / compute semantics are unit-testable in isolation — the provider in
// `projection.ts` is the only thing that touches the store.
//
// See docs/superpowers/specs/2026-07-31-projection-virtual-tables-design.md.

import type { ProjectionColumn, ProjectionSpec, Row } from '@easydb/shared';
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
