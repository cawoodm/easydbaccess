// packages/renderer/src/table/table-references.ts
//
// Who depends on a table, and what a rename has to do about it.
//
// Two things in the workspace point at a table BY NAME rather than by id:
//
//   - a Projection's spec (`source.config.sources[].tableName`) — deliberately,
//     so a source can be deleted and re-imported under the same name without
//     the projection losing it (see `ProjectionSource`);
//   - a View instance (`ViewInstance.tableName`), which snapshots the name when
//     the view is created.
//
// That binding is what makes a rename dangerous: change the name and every
// name-based reference points at something that no longer exists. So a rename
// has to (a) tell the user what is about to be affected, and (b) carry the
// references across with it. This module answers (a); the columns editor's
// `submit` does (b) using `repointProjectionSpec`.
//
// Pure and DOM-free — `table-references.test.ts` covers it.

import type { ProjectionSpec, Table, ViewInstance } from '@easydb/shared';
import type { FieldRename } from './column-merge.js';

export interface TableReferences {
  /** Projection tables whose spec names this table as a source. */
  projections: Table[];
  /** View instances bound to this table. */
  views: ViewInstance[];
}

/** The spec a projection table carries, or null when it is not a projection. */
export function specOf(table: Table): ProjectionSpec | null {
  if (table.source?.type !== 'projection') return null;
  const spec = table.source.config as unknown as ProjectionSpec | undefined;
  return spec && Array.isArray(spec.sources) ? spec : null;
}

/**
 * Everything that would break if the table currently called `name` were
 * renamed. `selfId` is excluded from the projection list — a projection that
 * reads from ITSELF is a cycle the editor already refuses, and listing the
 * table being renamed as its own dependent would just be noise.
 */
export function findTableReferences(name: string, tables: Table[], views: ViewInstance[], selfId?: string): TableReferences {
  const projections = tables.filter((t) => {
    if (t.id === selfId) return false;
    const spec = specOf(t);
    return !!spec && spec.sources.some((s) => s.tableName === name);
  });
  return { projections, views: views.filter((v) => v.tableName === name) };
}

/**
 * The spec with every source named `from` renamed to `to`, or null when it
 * references neither — so a caller can skip the write entirely.
 *
 * A rename is the one case where a name-bound reference MUST be rewritten:
 * unlike a delete-and-recreate, the table did not come back under the old name,
 * and nothing else will ever repair the link.
 */
export function repointProjectionSpec(spec: ProjectionSpec, from: string, to: string): ProjectionSpec | null {
  if (!spec.sources.some((s) => s.tableName === from)) return null;
  return { ...spec, sources: spec.sources.map((s) => (s.tableName === from ? { ...s, tableName: to } : s)) };
}

// -- Field renames ----------------------------------------------------------
//
// A projection names FIELDS as well as tables, in three places: its output
// fields (`columns[].field`, which key the projection table's own ColumnSpecs),
// the source fields it reads (`columns[].from.field`), and its join keys
// (`sources[].join.on`). None of them were rewritten when the columns editor
// renamed a field, so:
//
//   - renaming an output field of a projection emptied that column — the
//     compute still wrote the OLD key into every row, and the renamed
//     ColumnSpec read a key nothing carried;
//   - renaming a field of a SOURCE table emptied the projection's column that
//     read it, and left any join on that field matching nothing.
//
// Both are the same defect as a table rename: the field did not come back under
// the old name, so nothing else will ever repair the reference.

/** old field name → new field name, applied simultaneously (so a swap works). */
function renameMap(renames: readonly FieldRename[]): Map<string, string> {
  return new Map(renames.filter((r) => r.from !== r.to).map((r) => [r.from, r.to]));
}

/** Keys of `filters` put through `map`. Returns null when nothing moved. */
function renamedFilters(filters: Record<string, string> | undefined, map: Map<string, string>): Record<string, string> | null {
  if (!filters) return null;
  const hit = Object.keys(filters).some((k) => map.has(k));
  if (!hit) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(filters)) out[map.get(k) ?? k] = v;
  return out;
}

/**
 * A projection's OWN spec with its output fields renamed — for the case where
 * the columns editor renamed a column OF the projection. Returns null when the
 * renames touch none of them, so the caller can skip the write.
 */
export function renameProjectionOutputs(spec: ProjectionSpec, renames: readonly FieldRename[]): ProjectionSpec | null {
  const map = renameMap(renames);
  if (map.size === 0) return null;
  const columns = spec.columns.map((c) => (map.has(c.field) ? { ...c, field: map.get(c.field)! } : c));
  const filters = renamedFilters(spec.filters, map);
  const changed = columns.some((c, i) => c !== spec.columns[i]) || filters !== null;
  if (!changed) return null;
  return { ...spec, columns, ...(filters ? { filters } : {}) };
}

/**
 * A spec with `tableName`'s field renames applied to everything that names one
 * of them: the source columns read from that table, and the join keys on either
 * side of an equijoin. Returns null when the spec names none of them.
 *
 * Every alias bound to `tableName` is rewritten, not just the first — a
 * self-join gives one table two aliases, and both read the renamed field.
 */
export function renameProjectionSourceFields(spec: ProjectionSpec, tableName: string, renames: readonly FieldRename[]): ProjectionSpec | null {
  const map = renameMap(renames);
  if (map.size === 0) return null;
  const aliases = new Set(spec.sources.filter((s) => s.tableName === tableName).map((s) => s.alias));
  if (aliases.size === 0) return null;

  const columns = spec.columns.map((c) => (c.from.kind === 'source' && aliases.has(c.from.alias) && map.has(c.from.field) ? { ...c, from: { ...c.from, field: map.get(c.from.field)! } } : c));

  const sources = spec.sources.map((s) => {
    if (!s.join) return s;
    const mine = aliases.has(s.alias);
    const on = s.join.on.map((k) => {
      // `field` belongs to THIS source; `eqField` to the source it equals.
      const field = mine && map.has(k.field) ? map.get(k.field)! : k.field;
      const eqField = aliases.has(k.eqAlias) && map.has(k.eqField) ? map.get(k.eqField)! : k.eqField;
      return field === k.field && eqField === k.eqField ? k : { ...k, field, eqField };
    });
    return on.some((k, i) => k !== s.join!.on[i]) ? { ...s, join: { ...s.join, on } } : s;
  });

  const changed = columns.some((c, i) => c !== spec.columns[i]) || sources.some((s, i) => s !== spec.sources[i]);
  return changed ? { ...spec, columns, sources } : null;
}

/**
 * One line naming what depends on this table, or null when nothing does.
 *
 * Deliberately concrete — it names the projections and views rather than
 * counting them, because "2 projections will be updated" gives the user
 * nothing to check afterwards.
 */
export function describeReferences(refs: TableReferences): string | null {
  const parts: string[] = [];
  if (refs.projections.length > 0) parts.push(`${plural(refs.projections.length, 'projection')} (${list(refs.projections.map((t) => t.name))})`);
  if (refs.views.length > 0) parts.push(`${plural(refs.views.length, 'view')} (${list(refs.views.map((v) => v.name || 'untitled'))})`);
  return parts.length > 0 ? parts.join(' and ') : null;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Name up to three, then say how many more — a long list stops being readable. */
function list(names: string[]): string {
  const shown = names.slice(0, 3).map((n) => `"${n}"`);
  return names.length > 3 ? `${shown.join(', ')} and ${names.length - 3} more` : shown.join(', ');
}
