// packages/renderer/src/dialogs/projection-spec.ts
//
// The editor MODEL behind the projection dialog, and the pure transforms
// between it and a `ProjectionSpec`. Split out of the dialog so the lossy paths
// are unit-testable: a spec must survive `specToEditor` → `editorToSpec`
// unchanged, including the parts the UI does not model.
//
// DOM-free on purpose — no Lit, no store.

import type { ColumnSpec, ProjectionColumn, ProjectionSource, ProjectionSpec } from '@easydb/shared';
import { guessJoinKeys } from '../plugins/projection-compute.js';

/** A table the projection can draw from. */
export interface ProjectionCandidate {
  id: string;
  name: string;
  columns: ColumnSpec[];
}

/** One equijoin key pair, as the UI edits it (the first key of `join.on`). */
export interface EdJoin {
  type: 'inner' | 'left';
  thisField: string;
  otherAlias: string;
  otherField: string;
}

export interface EdSource {
  alias: string;
  tableId: string;
  tableName: string;
  columns: ColumnSpec[];
  join?: EdJoin;
  /**
   * Join keys BEYOND the first, carried through untouched. The UI only edits one
   * key pair; a multi-key spec (hand-written, or synced from a newer client) must
   * not be silently downgraded to a single key by opening and saving it.
   */
  extraOn?: Array<{ field: string; eqAlias: string; eqField: string }>;
}

/**
 * One row of the editor's column picker. Deliberately carries no presentation:
 * the projection dialog only decides WHICH columns exist and, for a computed
 * column, the script behind it. Labels, types, renderers and the rest are
 * inherited from the source table and edited afterwards with the ordinary
 * column editor.
 */
export interface EdColumn {
  include: boolean;
  /** Source columns: which source, and its stored field. */
  alias?: string;
  field?: string;
  /** Computed columns: the `function render(row)` body. */
  script?: string;
  computed: boolean;
  /**
   * The EXISTING output field name, when this column came from a saved spec.
   * Reused verbatim on save: the table's ColumnSpec, `filters`, sort and any
   * View template are keyed by it and would silently detach if it changed.
   */
  outField?: string;
  /** Display-only, for the picker's row label. Never written to the spec. */
  label?: string;
}

export interface EditorModel {
  name: string;
  sources: EdSource[];
  columns: EdColumn[];
  /** Row cap (TOP N). Absent ⇒ every row. */
  limit?: number | undefined;
  /**
   * The spec this model was loaded from. Kept so fields the editor does not
   * model (e.g. `filters`) survive a save instead of being dropped.
   */
  original?: ProjectionSpec;
}

export type BuildResult = { ok: true; name: string; spec: ProjectionSpec } | { ok: false; error: string };

/** Slugify a label into an output field name, unique within the spec. */
export function uniqueField(label: string, used: Set<string>): string {
  const base =
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'col';
  let field = base;
  let n = 2;
  while (used.has(field)) field = `${base}_${n++}`;
  used.add(field);
  return field;
}

/** Next free single-letter alias for a new source. */
export function nextAlias(sources: EdSource[]): string {
  for (let i = 0; ; i++) {
    const a = String.fromCharCode(97 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26)) : '');
    if (!sources.some((s) => s.alias === a)) return a;
  }
}

/** Load a saved spec into the editor model. */
export function specToEditor(name: string, spec: ProjectionSpec, candidates: ProjectionCandidate[]): EditorModel {
  const sources: EdSource[] = spec.sources.map((s) => {
    const cand = candidates.find((c) => c.name === s.tableName);
    const src: EdSource = {
      alias: s.alias,
      tableId: cand?.id ?? '',
      tableName: s.tableName,
      columns: cand?.columns ?? [],
    };
    const on = s.join?.on ?? [];
    const key0 = on[0];
    if (s.join && key0) {
      src.join = {
        type: s.join.type,
        thisField: key0.field,
        otherAlias: key0.eqAlias,
        otherField: key0.eqField,
      };
      if (on.length > 1) src.extraOn = on.slice(1);
    }
    return src;
  });

  const fromSpec: EdColumn[] = spec.columns.map((c) => {
    const base = { include: true, outField: c.field, label: c.label ?? c.field };
    return c.from.kind === 'source' ? { ...base, alias: c.from.alias, field: c.from.field, computed: false } : { ...base, script: c.from.script, computed: true };
  });

  // Offer EVERY field of every source, not just the ones already selected —
  // otherwise a column left out at creation (or added to the source table since)
  // could never be picked up again. Selected ones keep their `outField`; the rest
  // come in unticked, ready to be added.
  const columns: EdColumn[] = [];
  const claimed = new Set<EdColumn>();
  sources.forEach((s, i) => {
    const repeat = sources.slice(0, i).filter((o) => o.tableName === s.tableName).length;
    for (const col of s.columns) {
      const mine = fromSpec.filter((c) => !c.computed && c.alias === s.alias && c.field === col.field && !claimed.has(c));
      if (mine.length > 0) {
        for (const m of mine) {
          claimed.add(m);
          columns.push(m);
        }
      } else {
        columns.push({
          include: false,
          alias: s.alias,
          field: col.field,
          computed: false,
          label: repeat > 0 ? `${col.label} (${s.alias})` : col.label,
        });
      }
    }
  });
  // A selected column whose source no longer offers that field (renamed away, or
  // an unresolvable source) still has to be visible so it can be un-ticked.
  for (const c of fromSpec) if (!c.computed && !claimed.has(c)) columns.push(c);
  for (const c of fromSpec) if (c.computed) columns.push(c);

  return { name, sources, columns, ...(spec.limit ? { limit: spec.limit } : {}), original: spec };
}

/** Append a source (base if the model is empty, else a JOIN with guessed keys). */
export function addSourceToModel(model: EditorModel, cand: ProjectionCandidate): EditorModel {
  const alias = nextAlias(model.sources);
  const isBase = model.sources.length === 0;
  // How many times this table is already a source. A table may be joined more
  // than once (a self-join), so repeats get disambiguated labels below.
  const repeat = model.sources.filter((s) => s.tableName === cand.name).length;
  let join: EdJoin | undefined;
  if (!isBase) {
    // Preselect the keys from field-name heuristics (FK conventions, shared xId
    // columns, primary-key ↔ reference) so the user usually just confirms rather
    // than picks. Keys already consumed by another join are avoided, so joining
    // the same table twice lands on a different key each time.
    const usedKeys = model.sources.flatMap((s) => (s.join ? [{ alias: s.join.otherAlias, field: s.join.otherField }, ...(s.extraOn ?? []).map((k) => ({ alias: k.eqAlias, field: k.eqField }))] : []));
    const guess = guessJoinKeys(
      {
        tableName: cand.name,
        fields: cand.columns.map((c) => c.field),
        pks: cand.columns.filter((c) => c.unique).map((c) => c.field),
      },
      model.sources.map((s) => ({
        alias: s.alias,
        tableName: s.tableName,
        fields: s.columns.map((c) => c.field),
        pks: s.columns.filter((c) => c.unique).map((c) => c.field),
      })),
      usedKeys,
    );
    join = {
      type: 'left',
      thisField: guess?.thisField ?? cand.columns[0]?.field ?? '',
      otherAlias: guess?.otherAlias ?? model.sources[0]?.alias ?? '',
      otherField: guess?.otherField ?? '',
    };
  }
  const src: EdSource = {
    alias,
    tableId: cand.id,
    tableName: cand.name,
    columns: cand.columns,
    ...(join ? { join } : {}),
  };
  return {
    ...model,
    sources: [...model.sources, src],
    columns: [
      ...model.columns,
      ...cand.columns.map(
        (col): EdColumn => ({
          include: true,
          alias,
          field: col.field,
          computed: false,
          // Shown in the picker only. A repeat of the same table is qualified by
          // its alias so the two "Title" rows are tellable apart.
          label: repeat > 0 ? `${col.label} (${alias})` : col.label,
        }),
      ),
    ],
  };
}

/**
 * Remove a source and everything that depended on it. A join referencing the
 * removed alias would be left dangling — at compute time its key never matches,
 * so the projection would silently drop every row (inner) or null out every
 * joined column (left). Cascading keeps the model always valid instead.
 */
export function removeSourceFromModel(model: EditorModel, alias: string): EditorModel {
  const doomed = new Set([alias]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of model.sources) {
      if (doomed.has(s.alias) || !s.join) continue;
      const refs = [s.join.otherAlias, ...(s.extraOn ?? []).map((k) => k.eqAlias)];
      if (refs.some((a) => doomed.has(a))) {
        doomed.add(s.alias);
        grew = true;
      }
    }
  }
  return {
    ...model,
    sources: model.sources.filter((s) => !doomed.has(s.alias)),
    columns: model.columns.filter((c) => c.computed || !c.alias || !doomed.has(c.alias)),
  };
}

/** Append a blank computed column. */
export function addComputedToModel(model: EditorModel): EditorModel {
  return {
    ...model,
    columns: [...model.columns, { include: true, computed: true, label: 'computed', script: 'function render(row) {\n  return "";\n}' }],
  };
}

/** Validate the model and turn it back into a spec. */
export function editorToSpec(model: EditorModel): BuildResult {
  const name = model.name.trim();
  if (!name) return { ok: false, error: 'Give the projection a name.' };
  if (model.sources.length === 0) return { ok: false, error: 'Add at least one source table.' };
  const chosen = model.columns.filter((c) => c.include);
  if (chosen.length === 0) return { ok: false, error: 'Select at least one column.' };

  // A join may only reference a source introduced BEFORE it — that is what the
  // compute step assumes, and it is what catches an alias left dangling by a
  // removal.
  for (let i = 0; i < model.sources.length; i++) {
    const s = model.sources[i];
    if (!s?.join) continue;
    if (!s.join.thisField || !s.join.otherField) {
      return { ok: false, error: `Set both join keys for "${s.tableName}".` };
    }
    const earlier = new Set(model.sources.slice(0, i).map((x) => x.alias));
    const refs = [s.join.otherAlias, ...(s.extraOn ?? []).map((k) => k.eqAlias)];
    if (refs.some((a) => !earlier.has(a))) {
      return {
        ok: false,
        error: `The join for "${s.tableName}" refers to a table that is no longer part of this projection.`,
      };
    }
  }

  const aliases = new Set(model.sources.map((s) => s.alias));
  const used = new Set<string>();
  const outColumns: ProjectionColumn[] = [];
  for (const c of chosen) {
    // Keep an existing output field name; only mint one for a NEW column, from
    // the SOURCE field (there is no label to derive it from any more).
    let field: string;
    if (c.outField && !used.has(c.outField)) {
      field = c.outField;
      used.add(field);
    } else {
      field = uniqueField(c.computed ? 'computed' : (c.field ?? 'col'), used);
    }
    if (c.computed) {
      outColumns.push({ field, from: { kind: 'script', script: c.script ?? '' } });
      continue;
    }
    const alias = c.alias;
    const srcField = c.field;
    if (!alias || !srcField || !aliases.has(alias)) {
      return {
        ok: false,
        error: `Column "${c.label ?? c.field}" belongs to a table that is no longer part of this projection.`,
      };
    }
    outColumns.push({ field, from: { kind: 'source', alias, field: srcField } });
  }

  const sources: ProjectionSource[] = model.sources.map((s) => {
    // `EdSource.tableId` is the EDITOR's handle on the picked candidate; it is
    // deliberately not written to the spec, which binds by name alone.
    const out: ProjectionSource = { alias: s.alias, tableName: s.tableName };
    if (s.join) {
      out.join = {
        type: s.join.type,
        on: [{ field: s.join.thisField, eqAlias: s.join.otherAlias, eqField: s.join.otherField }, ...(s.extraOn ?? [])],
      };
    }
    return out;
  });

  // Spread the original FIRST so anything the editor does not model (today
  // `filters`) is carried forward rather than silently dropped on save.
  const spec: ProjectionSpec = {
    ...(model.original ?? {}),
    version: 1,
    sources,
    columns: outColumns,
  };
  // The editor owns the limit, so an emptied field must CLEAR a stored one
  // rather than letting the spread carry it forward.
  if (model.limit != null && model.limit > 0) spec.limit = Math.floor(model.limit);
  else delete spec.limit;
  return { ok: true, name, spec };
}
