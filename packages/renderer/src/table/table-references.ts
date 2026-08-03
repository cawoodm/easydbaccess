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
