// packages/renderer/src/plugins/sql-import.ts
//
// The `.sql` importer — the inverse of sql-export.ts. Parsing lives in the pure
// `sql-parse.ts`; this module is the plumbing around it.
//
// A `.sql` script can hold two different kinds of thing, and they need two
// different destinations:
//
//   CREATE TABLE / INSERT  →  ordinary tables. Plain tabular data, so they run
//                             on the import kernel exactly like a CSV: the
//                             dialog picks the destination up front, the kernel
//                             owns naming, the row cap and the write.
//   SELECT / CREATE VIEW   →  PROJECTIONS. A projection stores no rows — it is
//                             a spec plus inherited column settings — which no
//                             generic table writer can express. So a script
//                             containing one takes the `restoreSqlScript` path
//                             below, mirroring how a `.db.json` workspace dump
//                             bypasses the kernel for `restoreWorkspaceDump`.
//
// `hasSqlProjections` is how a caller tells the two apart before choosing.

import type { ColumnSpec, HostApi, ImporterSpec, ImportSourceInput, PluginModule, Table } from '@easydb/shared';
import { filenameFromUrl } from '../import/fetch-source.js';
import { landCandidate, type ImportTarget } from '../import/land-tables.js';
import { runImport } from '../import/import-kernel.js';
import { createProjectionTable } from './projection-create.js';
import { parseSqlScript, type ParsedSql } from './sql-parse.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'sql-import',
  name: 'SQL Import',
  type: 'importer',
  version: '0.1.0',
  description: 'Import a .sql script: CREATE TABLE + INSERT become tables, and each SELECT (or CREATE VIEW) becomes a projection.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/sql-import.ts',
};

export function init(api: HostApi): void {
  api.ui.registerImporter(importerSpec);
  api.ui.registerDropHandler(async (event) => {
    const files = filesFrom(event).filter(isSql);
    if (files.length === 0) return false;
    event.preventDefault();
    for (const file of files) await importSqlFile(api, file);
    return true;
  });
}

// -- Importer spec -----------------------------------------------------------

/** What the spec passes from `list` to `read`. */
interface SqlHandle {
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
}

const importerSpec: ImporterSpec = {
  id: 'sql',
  label: 'SQL script (CREATE TABLE / INSERT / SELECT)',
  icon: 'storage',
  order: 30,
  accept: ['.sql', 'application/sql', 'text/sql', 'application/x-sql'],
  supports: { url: true, file: true, text: true, multiTable: true, kernel: true },

  detect(input) {
    const name = input.kind === 'file' ? (input.file?.name ?? '') : (input.url ?? '');
    if (/\.sql$/i.test(name)) return 1;
    if ((input.file?.type ?? '').includes('sql')) return 0.9;
    // A body starting with a DDL/DML keyword is a script whatever it is called.
    return /^\s*(--|\/\*|BEGIN\b|CREATE\s+TABLE\b|INSERT\s+INTO\b|DROP\s+TABLE\b)/i.test(input.text ?? '') ? 0.6 : 0;
  },

  async list(ctx, input) {
    const parsed = parseSqlScript(await readInput(ctx, input));
    // Projections are not table candidates — they have no rows to land. A
    // script that is ONLY projections still needs a candidate, or the kernel
    // reports "no tables found"; `restoreSqlScript` is the path that creates
    // them, and `hasSqlProjections` routes there before the kernel is reached.
    return parsed.tables.map((t) => ({
      name: t.name,
      rowCount: t.rows.length,
      handle: { columns: t.columns, rows: t.rows } satisfies SqlHandle,
    }));
  },

  async *read(_ctx, candidate) {
    const { columns, rows } = candidate.handle as SqlHandle;
    yield { columns, rows };
  },
};

/** Read whichever form the input takes into the script text. */
function readInput(ctx: { fetchText(url: string, label?: string): Promise<string> }, input: ImportSourceInput): Promise<string> {
  if (input.kind === 'file' && input.file) return input.file.text();
  if (input.kind === 'url' && input.url) return ctx.fetchText(input.url, `Reading ${filenameFromUrl(input.url)}…`);
  return Promise.resolve(input.text ?? '');
}

// -- The projection path -----------------------------------------------------

/**
 * True when this script defines at least one projection, so it must go through
 * {@link restoreSqlScript} rather than the import kernel. Exported so the
 * Import dialog and the drop handler can decide before either path runs.
 */
export function hasSqlProjections(text: string): boolean {
  return parseSqlScript(text).projections.length > 0;
}

export interface RestoreSqlResult {
  /** Tables created or written, by their final (uniqued) name. */
  tables: string[];
  projections: string[];
  rowCount: number;
  /** Whatever the parser could not model — surfaced, never swallowed. */
  unsupported: string[];
}

/**
 * Import a whole `.sql` script: its tables first, then its projections, which
 * are pointed at the tables that were just created.
 *
 * Tables go through `landCandidate` so naming, collision policy and the row cap
 * are the same ones every other importer follows — this path bypasses the
 * kernel only for what the kernel cannot express, not for the parts it can.
 */
export async function restoreSqlScript(
  api: HostApi,
  text: string,
  opts: {
    maxRows?: number | undefined;
    /**
     * The dialog's "Import into" choice. Honoured only when the script defines
     * exactly ONE table — an append/overwrite names a single destination, and
     * there is no sane way to spread it across several. With more, the choice
     * is reported as not applied rather than quietly ignored.
     */
    target?: ImportTarget | undefined;
    editColumns?: ((columns: ColumnSpec[], tableName: string) => Promise<ColumnSpec[] | null>) | undefined;
  } = {},
): Promise<RestoreSqlResult> {
  const workspaceId = api.workspaceId();
  if (!workspaceId) throw new Error('sql-import: no active workspace');

  const parsed: ParsedSql = parseSqlScript(text);
  const result: RestoreSqlResult = { tables: [], projections: [], rowCount: 0, unsupported: parsed.unsupported };

  const chosenTarget = opts.target ?? { kind: 'new' };
  const canUseTarget = chosenTarget.kind === 'new' || parsed.tables.length === 1;
  if (!canUseTarget) {
    result.unsupported.push(`"Import into" was not applied — this script defines ${parsed.tables.length} tables, and an append/replace names only one destination`);
  }

  /**
   * Script name → the name the table actually landed under. A projection's
   * spec refers to its sources by name, so a table uniqued to `people-2`
   * must be re-pointed or the projection would resolve nothing.
   */
  const landedAs = new Map<string, string>();

  for (const t of parsed.tables) {
    const landed = await landCandidate(
      api,
      t.name,
      (async function* () {
        yield { columns: t.columns, rows: t.rows };
      })(),
      {
        workspaceId,
        importerId: 'sql',
        target: canUseTarget ? chosenTarget : { kind: 'new' },
        ...(opts.maxRows !== undefined ? { maxRows: opts.maxRows } : {}),
        ...(opts.editColumns ? { editColumns: (cols: ColumnSpec[]) => opts.editColumns!(cols, t.name) } : {}),
      },
    );
    if (!landed) continue; // the user cancelled this table's column editor
    landedAs.set(t.name, landed.tableName);
    result.tables.push(landed.tableName);
    result.rowCount += landed.rowCount;
  }

  // Existing workspace tables are join candidates too: a script holding only a
  // SELECT is a projection over tables the user already has.
  const existing = await api.store.tables.find({ workspaceId });
  const byName = new Map<string, Table>();
  for (const t of existing) if (!byName.has(t.name)) byName.set(t.name, t);
  // …matched case-insensitively as a fallback, because a SQL identifier is
  // lowercased by our own exporter while the table it came from was "People".
  const byLowerName = new Map<string, Table>();
  for (const t of existing) if (!byLowerName.has(t.name.toLowerCase())) byLowerName.set(t.name.toLowerCase(), t);

  const takenProjectionNames = new Set([...existing.map((t) => t.name), ...result.tables]);

  for (const p of parsed.projections) {
    const created = await createProjectionTable(api, workspaceId, p, {
      // Prefer a table this same script just landed (its name may have been
      // uniqued), then an exact name, then a case-insensitive one — our own
      // exporter lowercases identifiers, so `People` comes back as `people`.
      resolve: (n) => {
        const landed = landedAs.get(n);
        return (landed ? byName.get(landed) : undefined) ?? byName.get(n) ?? byLowerName.get(n.toLowerCase());
      },
      taken: takenProjectionNames,
    });
    if (!created) {
      result.unsupported.push(`projection "${p.name}" — its source tables are not in this workspace`);
      continue;
    }
    // Register it so a LATER projection in the same script can read from it —
    // a projection over a projection is legal, and the export writes them in
    // declaration order.
    byName.set(created.name, created);
    byLowerName.set(created.name.toLowerCase(), created);
    takenProjectionNames.add(created.name);
    result.projections.push(created.name);
  }

  return result;
}

/** One toast describing what a `.sql` script produced — including what it could not. */
export function reportSqlRestore(api: HostApi, res: RestoreSqlResult, label: string): void {
  const parts: string[] = [];
  if (res.tables.length > 0) parts.push(`${res.tables.length} table${res.tables.length === 1 ? '' : 's'} (${res.rowCount.toLocaleString()} rows)`);
  if (res.projections.length > 0) parts.push(`${res.projections.length} projection${res.projections.length === 1 ? '' : 's'}`);
  if (parts.length === 0) {
    api.ui.dialogs.toast(`Nothing importable found in ${label}.`, { kind: 'warning', title: 'SQL import' });
    return;
  }
  // Say what was skipped in the same breath as what worked — a script that
  // half-imported must not read as a clean success.
  const skipped =
    res.unsupported.length > 0
      ? ` — ${res.unsupported.length} statement${res.unsupported.length === 1 ? '' : 's'} could not be imported: ${res.unsupported.slice(0, 3).join('; ')}${res.unsupported.length > 3 ? '…' : ''}`
      : '';
  api.ui.dialogs.toast(`Imported ${parts.join(' and ')} from ${label}${skipped}.`, { kind: res.unsupported.length > 0 ? 'warning' : 'success', title: 'SQL import' });
}

// -- Drag and drop -----------------------------------------------------------

/**
 * A dropped `.sql` file. A script defining projections is restored whole;
 * anything else is plain tabular data and goes through the kernel, so a dropped
 * file lands exactly like the same file chosen in the Import dialog.
 */
async function importSqlFile(api: HostApi, file: File): Promise<void> {
  const text = await file.text();
  try {
    if (hasSqlProjections(text)) {
      reportSqlRestore(api, await restoreSqlScript(api, text), file.name);
      return;
    }
    const res = await runImport(api, importerSpec, { kind: 'text', text, name: file.name }, { mode: 'copy', target: { kind: 'new' } });
    const rows = res.landed.reduce((n, l) => n + l.rowCount, 0);
    if (res.landed.length > 0) {
      api.ui.dialogs.toast(`Imported ${res.landed.length} table${res.landed.length === 1 ? '' : 's'} (${rows.toLocaleString()} rows) from ${file.name}.`, { kind: 'success', title: 'SQL import' });
    } else {
      api.ui.dialogs.toast(`Nothing importable found in ${file.name}.`, { kind: 'warning', title: 'SQL import' });
    }
  } catch (err) {
    api.ui.dialogs.toast(`Could not import ${file.name}: ${(err as Error).message}`, { kind: 'error', title: 'SQL import' });
  }
}

function filesFrom(event: DragEvent): File[] {
  const dt = event.dataTransfer;
  if (!dt) return [];
  if (dt.files && dt.files.length > 0) return Array.from(dt.files);
  const out: File[] = [];
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}

function isSql(file: File): boolean {
  return /\.sql$/i.test(file.name) || (file.type ?? '').includes('sql');
}

/** The importer spec, for callers that dispatch to the kernel themselves. */
export { importerSpec as sqlImporterSpec };
