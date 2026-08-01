// packages/renderer/src/plugins/projection-compute.ts
//
// The pure heart of a Projection (a virtual table / database view / JOIN):
// given a `ProjectionSpec` and the rows of each participating source table,
// compute the derived rows. DOM- and Dexie-free on purpose so the join / filter
// / select / compute semantics are unit-testable in isolation — the provider in
// `projection.ts` is the only thing that touches the store.
//
// See docs/superpowers/specs/2026-07-31-projection-virtual-tables-design.md.

import type {
  ColumnSpec,
  ProjectionColumn,
  ProjectionSource,
  ProjectionSpec,
  Row,
  SortSpec,
  Table,
} from '@easydb/shared';
import { runColumnScript } from '../util/column-script.js';
import { isInternalField } from '../util/internal-fields.js';

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

// -- Inheriting column settings from the source tables ---------------------

/**
 * Build the projection table's `columns`, inheriting each column's settings from
 * the source table it comes from — ONCE, when the column first appears.
 *
 * The split of responsibilities:
 *  - the SPEC decides which columns exist and where their values come from;
 *  - the TABLE's `columns` carry everything about how they look (label, type,
 *    renderer, width, hidden, description, units, constraints).
 *
 * So a column is seeded with a full copy of the source column and is the user's
 * from then on: `existing` always wins, which is what lets the ordinary column
 * editor work on a projection exactly as it does on a table. A field the user
 * deleted there (recorded in `deletedColumns`) stays gone.
 *
 * `readonly` is the one setting the projection keeps asserting: a computed or
 * secondary-source column has no unambiguous write target, so it cannot become
 * editable however the table is edited.
 */
export function inheritColumns(
  spec: ProjectionSpec,
  sourceColumnsByAlias: Record<string, ColumnSpec[]>,
  existing: ColumnSpec[] = [],
  deletedColumns: string[] = [],
): ColumnSpec[] {
  const writable = resolveWritability(spec);
  const byField = new Map(existing.map((c) => [c.field, c] as const));
  const deleted = new Set(deletedColumns);
  const out: ColumnSpec[] = [];

  for (const c of spec.columns) {
    if (deleted.has(c.field)) continue; // removed with the column editor
    const kept = byField.get(c.field);
    let col: ColumnSpec;
    if (kept) {
      col = { ...kept };
    } else if (c.from.kind === 'source') {
      const from = c.from;
      const source = (sourceColumnsByAlias[from.alias] ?? []).find((sc) => sc.field === from.field);
      // Copy the WHOLE source column (renderer, width, hidden, units, …), then
      // re-point it at this projection's output field name.
      col = source
        ? { ...source, field: c.field }
        : { field: c.field, label: c.label ?? c.field, type: c.type ?? 'string' };
      if (isInternalField(from.field)) col.hidden = true;
    } else {
      col = { field: c.field, label: c.label ?? c.field, type: c.type ?? 'string' };
      col.script = c.from.script;
    }
    if (!writable.has(c.field)) col.readonly = true;
    else delete col.readonly;
    out.push(col);
  }
  return out;
}

// -- Carrying the base table's presentation over ---------------------------

/**
 * Map each BASE-table stored field to the projection's output field, so the
 * base table's presentation can be expressed in the projection's own terms.
 */
function baseFieldToOutput(spec: ProjectionSpec): Map<string, string> {
  const baseAlias = spec.sources[0]?.alias;
  const map = new Map<string, string>();
  if (!baseAlias) return map;
  for (const c of spec.columns) {
    if (c.from.kind === 'source' && c.from.alias === baseAlias && !map.has(c.from.field)) {
      map.set(c.from.field, c.field);
    }
  }
  return map;
}

/** The subset of a Table's presentation a new projection inherits. */
export interface CarriedPresentation {
  sortBy?: SortSpec[] | undefined;
  sortColumn?: string | undefined;
  sortAsc?: boolean | undefined;
  filters?: Record<string, string> | undefined;
}

/**
 * Copy the base table's sort and filters onto a projection built from it, so the
 * projection opens showing what the user was already looking at rather than an
 * unsorted, unfiltered grid.
 *
 * Keys are translated from the base table's stored fields to the projection's
 * output fields; anything whose column was not selected is dropped rather than
 * carried over as a dangling reference. (Hidden columns travel separately, on
 * the spec's own columns — see `ProjectionColumn.hidden`.)
 */
export function presentationFromBase(spec: ProjectionSpec, base: Table): CarriedPresentation {
  const map = baseFieldToOutput(spec);
  const out: CarriedPresentation = {};

  const baseSort: SortSpec[] =
    base.sortBy && base.sortBy.length > 0
      ? base.sortBy
      : base.sortColumn
        ? [{ field: base.sortColumn, asc: base.sortAsc ?? true }]
        : [];
  const sortBy: SortSpec[] = [];
  for (const key of baseSort) {
    const field = map.get(key.field);
    if (field) sortBy.push({ field, asc: key.asc });
  }
  if (sortBy.length > 0) {
    out.sortBy = sortBy;
    const first = sortBy[0];
    if (first) {
      out.sortColumn = first.field;
      out.sortAsc = first.asc;
    }
  }

  if (base.filters) {
    const filters: Record<string, string> = {};
    for (const [field, value] of Object.entries(base.filters)) {
      const outField = map.get(field);
      if (outField && value) filters[outField] = value;
    }
    if (Object.keys(filters).length > 0) out.filters = filters;
  }

  return out;
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
  /** Fields that identify a row (a primary key), when the source reports them. */
  pks?: string[] | undefined;
}

/** A preselected equijoin: this new source's `thisField` = `otherAlias`.`otherField`. */
export interface GuessedJoin {
  thisField: string;
  otherAlias: string;
  otherField: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const singular = (s: string): string => (s.endsWith('s') && s.length > 1 ? s.slice(0, -1) : s);

/** A field looks like it REFERENCES another table's key: `id`, `other_id`, … */
const looksLikeRef = (f: string): boolean => f === 'id' || f.endsWith('id');

/** One side of a candidate key pair. */
interface KeySide {
  table: string;
  field: string;
  isPk: boolean;
}

/**
 * Score how likely two fields form a join key (0 = no signal). Recognises:
 *  - a shared foreign-key-shaped column on both sides (`customerId` = `customerId`),
 *  - the classic FK convention: one side `id`, the other `<thatTable>Id`
 *    (`Dept.id` = `People.deptId`),
 *  - a primary key paired with a reference-shaped field, which is what catches a
 *    key NOT called `id` (`til.path` = `similarities.other_id`).
 *
 * Two guards keep it from preselecting nonsense:
 *  - a bare `id` = `id` scores 0 — joining unrelated tables on `id` is almost
 *    always wrong;
 *  - the SAME table on both sides only matches on a real FK signal, never on an
 *    identical column name. In a self-join every column name matches itself, so
 *    `b.path = c.path` carries no information and would join each row to itself.
 */
function scoreJoinPair(a: KeySide, b: KeySide): number {
  const n = norm(a.field);
  const e = norm(b.field);
  if (!n || !e) return 0;
  const sameTable = norm(a.table) === norm(b.table);

  if (n === e) {
    if (sameTable || n === 'id') return 0;
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
  const byConvention = Math.max(fk(n, a.table, e), fk(e, b.table, n));
  if (byConvention > 0) return byConvention;

  // A primary key on one side, a reference-shaped field on the other. Weaker
  // than the naming conventions above, so those still win when both apply.
  if (a.isPk && looksLikeRef(e)) return 6;
  if (b.isPk && looksLikeRef(n)) return 6;
  return 0;
}

/**
 * Guess the equijoin keys for a newly-added source against the already-chosen
 * ones, so the editor preselects sensible fields instead of blanks. Returns the
 * highest-scoring pair, or null when nothing looks like a key.
 *
 * `usedKeys` are the earlier-source fields existing joins already consume. They
 * are only considered if nothing unused scores, so joining the same table twice
 * picks a DIFFERENT key each time — `similarities.id` for the first `til`, then
 * `similarities.other_id` for the second.
 */
export function guessJoinKeys(
  newSource: { tableName: string; fields: string[]; pks?: string[] | undefined },
  earlierSources: JoinColumnsRef[],
  usedKeys: Array<{ alias: string; field: string }> = [],
): GuessedJoin | null {
  const used = new Set(usedKeys.map((k) => `${k.alias} ${k.field}`));
  const newPks = new Set(newSource.pks ?? []);

  const bestOf = (skipUsed: boolean): GuessedJoin | null => {
    let best: GuessedJoin | null = null;
    let bestScore = 0;
    for (const es of earlierSources) {
      const esPks = new Set(es.pks ?? []);
      for (const nf of newSource.fields) {
        for (const ef of es.fields) {
          if (skipUsed && used.has(`${es.alias} ${ef}`)) continue;
          const s = scoreJoinPair(
            { table: newSource.tableName, field: nf, isPk: newPks.has(nf) },
            { table: es.tableName, field: ef, isPk: esPks.has(ef) },
          );
          if (s > bestScore) {
            bestScore = s;
            best = { thisField: nf, otherAlias: es.alias, otherField: ef };
          }
        }
      }
    }
    return best;
  };

  return bestOf(true) ?? bestOf(false);
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
