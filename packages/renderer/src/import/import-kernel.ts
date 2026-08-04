// packages/renderer/src/import/import-kernel.ts
//
// Drives one import from a chosen ImporterSpec. Everything common lives here so
// a format plugin only has to describe its format:
//
//   detect → list → (pick candidates) → read batches → land
//
// The importer is called at most three times and never touches the store.

import type { ColumnSpec, HostApi, ImportBatch, ImportCandidate, ImporterSpec, ImportCtx, ImportSourceInput, TableOrigin } from '@easydb/shared';
import { chooseTables } from '../dialogs/table-select-dialog.js';
import { cryptoUUID, slugTable } from '../util/ids.js';
import { fetchImportTextWithBar } from './fetch-source.js';
import { landCandidate, takenNames, uniqueTableName, type ImportTarget, type LandResult } from './land-tables.js';

export interface RunImportOptions {
  /** Copy = a local snapshot. Reference = a live read-only table, no rows stored. */
  mode: 'copy' | 'reference';
  target: ImportTarget;
  maxRows?: number | undefined;
  /** Review the columns before a NEW table is created. Null cancels. */
  editColumns?: ((columns: ColumnSpec[]) => Promise<ColumnSpec[] | null>) | undefined;
  /** Values from the importer's own dialog panel, if it registered one. */
  panel?: Record<string, unknown> | undefined;
  /** Resume cursor for continuing an interrupted import. */
  cursor?: string | undefined;
  /**
   * Stamp this origin on new tables instead of the one derived from the input.
   * Needed when the caller already read the body and hands the kernel `text`,
   * so the URL it came from is no longer visible in the input.
   */
  origin?: TableOrigin | undefined;
}

/**
 * Build the ctx an importer receives. `fetchText` carries the shared read
 * policy: the CORS rewrite, the informative errors, the slow-read progress bar,
 * and the size ceiling — lifted for a Reference (which persists nothing) or a
 * capped import (which keeps only a prefix). See `fetch-source.ts`.
 */
function makeCtx(api: HostApi, opts: RunImportOptions, extra: Partial<ImportCtx> = {}): ImportCtx {
  const uncapped = opts.mode === 'reference' || opts.maxRows != null;
  return {
    api,
    fetchText: (url, label) => fetchImportTextWithBar(api, url, label ?? 'Reading…', uncapped ? { maxBytes: null } : {}),
    panel: opts.panel ?? {},
    ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
    ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
    ...extra,
  };
}

export interface RunImportResult {
  landed: LandResult[];
  /** Candidates the user chose but which failed, with the reason. */
  failed: Array<{ name: string; error: string }>;
  /** True when the user cancelled at the picker or the column editor. */
  cancelled: boolean;
}

/**
 * Ask which of the source's tables to import. A single candidate skips the
 * picker; several open the shared checklist, which is the one piece of import UI
 * that was already reused across formats.
 */
async function pickCandidates(spec: ImporterSpec, candidates: ImportCandidate[]): Promise<ImportCandidate[] | null> {
  if (candidates.length <= 1) return candidates;
  const picked = await chooseTables(
    candidates.map((c) => ({
      name: c.name,
      size: c.rowCount,
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
      ...(c.hidden !== undefined ? { hidden: c.hidden } : {}),
    })),
    {
      title: `Import from ${spec.label}`,
      message: `This source offers ${candidates.length} tables. Choose which to import.`,
      confirmLabel: 'Import',
    },
  );
  if (!picked) return null;
  return picked.map((i) => candidates[i]!);
}

/**
 * Create a live read-only "reference" table: the `TableSource` comes from the
 * importer, the columns from the FIRST batch of a normal read. Nothing is
 * persisted — the row-source provider re-fetches on demand — so we read one
 * batch purely to learn the schema, which is what the old `createUrlReference`
 * did too.
 */
async function landReference(api: HostApi, spec: ImporterSpec, ctx: ImportCtx, candidate: ImportCandidate, workspaceId: string): Promise<LandResult> {
  if (!spec.reference) {
    throw new Error(`${spec.label} cannot be referenced — import a copy instead.`);
  }
  // Throws with the importer's own message for e.g. an upload (no re-fetchable
  // URL) or an ambiguous multi-table document. Do that BEFORE the read, so an
  // impossible reference costs no network.
  const source = spec.reference(ctx, candidate);

  let columns: ColumnSpec[] = [];
  for await (const batch of spec.read(ctx, candidate)) {
    columns = batch.columns ?? [];
    break; // one batch is enough to learn the schema
  }
  if (columns.length === 0) throw new Error('No columns found in the referenced data.');

  const name = uniqueTableName(await takenNames(api, workspaceId), candidate.name);
  const tableId = cryptoUUID();
  await api.store.tables.insert({
    id: tableId,
    workspaceId,
    name,
    code: slugTable(name),
    columns,
    view: 'table',
    source,
    // A reference's rows live at the source and its provider throws on every
    // write, so the grid must not offer editors it cannot honour. The user can
    // still clear the flag in the column editor if they want to see why.
    readonly: true,
    updatedAt: Date.now(),
  });
  return { tableId, tableName: name, rowCount: 0, created: true };
}

export async function runImport(api: HostApi, spec: ImporterSpec, input: ImportSourceInput, opts: RunImportOptions): Promise<RunImportResult> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('No active workspace.');

  const ctx = makeCtx(api, opts);
  const all = await spec.list(ctx, input);
  if (all.length === 0) throw new Error('No tables found at that source.');

  const chosen = await pickCandidates(spec, all);
  if (chosen === null) return { landed: [], failed: [], cancelled: true };

  const landed: LandResult[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const candidate of chosen) {
    try {
      if (opts.mode === 'reference') {
        landed.push(await landReference(api, spec, ctx, candidate, workspaceId));
        continue;
      }

      // A Copy. For append/overwrite the importer needs the destination's
      // columns so it can map its values the way its format requires.
      const target = opts.target;
      let targetColumns: ImportCtx['targetColumns'];
      if (target.kind !== 'new') {
        const existing = await api.store.tables.findOne(target.tableId);
        targetColumns = existing?.columns;
      }
      const readCtx = makeCtx(api, opts, {
        ...(targetColumns ? { targetColumns } : {}),
      });

      const batches: AsyncIterable<ImportBatch> = spec.read(readCtx, candidate);
      const origin: TableOrigin | undefined = opts.origin ?? (input.kind === 'url' && input.url ? { type: spec.id, url: input.url } : undefined);

      const result = await landCandidate(api, candidate.name, batches, {
        workspaceId,
        importerId: spec.id,
        target,
        ...(origin ? { origin } : {}),
        ...(opts.editColumns ? { editColumns: opts.editColumns } : {}),
        ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
      });
      if (result === null) return { landed, failed, cancelled: true };
      landed.push(result);
    } catch (err) {
      failed.push({ name: candidate.name, error: (err as Error)?.message ?? String(err) });
    }
  }

  return { landed, failed, cancelled: false };
}
