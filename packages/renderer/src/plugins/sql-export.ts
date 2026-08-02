import type { ColumnSpec, ColumnType, HostApi, PluginModule, ProjectionSpec, Row, Table } from '@easydb/shared';
import { slugTable } from '../util/ids.js';
import { buildProjectionSelect } from './projection-sql.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'sql-export',
  name: 'SQL Export',
  type: 'exporter',
  version: '0.1.0',
  description: 'Export the current workspace as a portable .sql script (CREATE TABLE + INSERT).',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/sql-export.ts',
};

export function init(): void {
  // SQL export is offered through the consolidated Export menu (see
  // dump-export.ts); this module now only provides serializeWorkspaceAsSql().
}

/**
 * Serializes every table in the active workspace as ANSI SQL: `DROP TABLE IF
 * EXISTS` → `CREATE TABLE` → `INSERT INTO` per table, wrapped in a single
 * transaction. Identifiers are double-quoted (ANSI standard — works as-is on
 * PostgreSQL/SQLite; for MySQL, set `sql_mode='ANSI_QUOTES'` before running).
 *
 * The synthesized `__id` PRIMARY KEY column carries the Row.id so re-imports
 * (or downstream tools) have a stable key — easyDBAccess row IDs are opaque
 * strings, not auto-increment numbers.
 */
export async function serializeWorkspaceAsSql(api: HostApi): Promise<string> {
  const wsId = api.workspaceId();
  if (!wsId) throw new Error('sql-export: no active workspace');

  const all = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  // A projection stores nothing, so it is exported as the SELECT that defines
  // it — after the tables it reads from, since a view needs them to exist.
  const tables = all.filter((t) => t.source?.type !== 'projection');
  const projections = all.filter((t) => t.source?.type === 'projection');
  // One naming authority for the whole dump: the SELECTs must reference the
  // very identifiers the CREATE TABLEs declare.
  const resolve = sqlNameResolver(all);

  const lines: string[] = [
    `-- easyDBAccess SQL dump`,
    `-- workspace: ${wsId}`,
    `-- exported:  ${new Date().toISOString()}`,
    `-- tables:    ${tables.length}${projections.length > 0 ? ` (+ ${projections.length} projection${projections.length === 1 ? '' : 's'})` : ''}`,
    `-- Compatible with PostgreSQL and SQLite. For MySQL run`,
    `--   SET sql_mode='ANSI_QUOTES';`,
    `-- before executing, or rewrite "ident" to \`ident\`.`,
    ``,
    `BEGIN;`,
    ``,
  ];

  for (const t of tables) {
    const rows = await api.store.rows(t.id).find();
    lines.push(renderTable(t, rows), '');
  }

  lines.push(`COMMIT;`, '');

  if (projections.length > 0) {
    lines.push('', `-- Projections (virtual tables). Each is the query behind one, reading the`, `-- tables above. Run them as-is, or wrap one in CREATE VIEW to keep it.`, '');
    for (const p of projections) {
      lines.push(`-- projection: ${p.name}`, projectionSelectBody(p, resolve) ?? '', '');
    }
  }
  return lines.join('\n');
}

/**
 * Map a table NAME onto the SQL identifier this exporter writes for it.
 *
 * `renderTable` names a table after its `code`, while a projection's spec
 * refers to its sources by `name` — so without this the SELECT referenced
 * `"My_Table"` while the CREATE TABLE declared `"my_table"`, and the exported
 * query would not run against the exported dump. Falls back to the slug a
 * table would have been given, which is what `code` holds for every table this
 * app creates.
 */
function sqlNameResolver(tables: Table[]): (tableName: string) => string {
  const byName = new Map<string, string>();
  for (const t of tables) if (!byName.has(t.name)) byName.set(t.name, sanitizeIdent(t.code || t.name));
  return (name) => byName.get(name) ?? sanitizeIdent(slugTable(name));
}

/**
 * Serializes a single table (+ its already-fetched, already-scoped rows) as a
 * standalone `.sql` script: the same `DROP TABLE IF EXISTS` → `CREATE TABLE`
 * → `INSERT INTO` shape `serializeWorkspaceAsSql` emits per table, wrapped in
 * its own transaction. Used by the per-table export menu (dump-export.ts) —
 * `table`/`rows` should already be narrowed to the desired export scope
 * (Raw vs. Visible Data; see `../export/table-file.js`).
 */
export function serializeTableAsSql(table: Table, rows: Row[]): string {
  // A projection is a QUERY, not stored data: export the SELECT that defines it
  // (join, filters and row cap included) rather than a dump of derived rows.
  const projection = projectionSelectFor(table);
  if (projection) return projection;

  const lines: string[] = [`-- easyDBAccess table export`, `-- table:    ${table.name}`, `-- exported: ${new Date().toISOString()}`, ``, `BEGIN;`, ``, renderTable(table, rows), ``, `COMMIT;`, ``];
  return lines.join('\n');
}

/**
 * The `.sql` body for a projection table, or null when `table` is not one.
 *
 * Source aliases are mapped to the SQL table names the rest of this exporter
 * uses, so the SELECT lines up with the `CREATE TABLE`s in a whole-workspace
 * dump. `resolveName` is that mapping; a standalone per-table export has no
 * workspace to consult and falls back to the slug rule every table follows.
 */
export function projectionSelectFor(table: Table, resolveName?: (tableName: string) => string): string | null {
  const select = projectionSelectBody(table, resolveName);
  if (select === null) return null;
  return [
    `-- easyDBAccess projection export`,
    `-- projection: ${table.name}`,
    `-- exported:   ${new Date().toISOString()}`,
    `--`,
    `-- A projection is a derived (virtual) table: this is the query behind it,`,
    `-- reading the source tables by name.`,
    `-- Compatible with PostgreSQL and SQLite. For MySQL run`,
    `--   SET sql_mode='ANSI_QUOTES';`,
    `-- before executing. For SQL Server / HANA, replace the trailing LIMIT n`,
    `-- with SELECT TOP n.`,
    ``,
    select,
  ].join('\n');
}

/**
 * Just the SELECT for a projection table — no header — or null when `table` is
 * not one. A whole-workspace dump explains projections once in its own section
 * and labels each with a single `-- projection:` line, so it wants the bare
 * query; only a standalone per-table export needs the full preamble.
 */
export function projectionSelectBody(table: Table, resolveName?: (tableName: string) => string): string | null {
  if (table.source?.type !== 'projection') return null;
  const spec = table.source.config as unknown as ProjectionSpec | undefined;
  if (!spec || !Array.isArray(spec.sources)) return null;

  const nameOf = resolveName ?? ((n: string) => sanitizeIdent(slugTable(n)));
  const tableNames: Record<string, string> = {};
  for (const s of spec.sources) tableNames[s.alias] = nameOf(s.tableName);
  const orderBy = spec.sources.length > 0 && table.sortBy && table.sortBy.length > 0 ? table.sortBy : table.sortColumn ? [{ field: table.sortColumn, asc: table.sortAsc ?? true }] : undefined;

  // ANSI-flavoured, matching the rest of this exporter: double-quoted
  // identifiers and a trailing `LIMIT n` — the row-cap spelling that runs on
  // both targets the dump promises. (`FETCH FIRST n ROWS ONLY` is the stricter
  // SQL:2008 form but SQLite rejects it; `TOP n` is SQL Server / HANA.)
  return buildProjectionSelect(spec, {
    tableNames,
    limitStyle: 'limit',
    ...(orderBy ? { orderBy } : {}),
  });
}

function renderTable(table: Table, rows: Row[]): string {
  const tableName = sanitizeIdent(table.code || table.name || `table_${table.id}`);
  const colDefs = [`  "__id" TEXT PRIMARY KEY`, ...table.columns.map((c) => `  ${renderColumnDef(c)}`)];
  const out: string[] = [`DROP TABLE IF EXISTS "${tableName}";`, `CREATE TABLE "${tableName}" (`, colDefs.join(',\n'), `);`];

  if (rows.length > 0) {
    const fields = ['__id', ...table.columns.map((c) => c.field)];
    const colList = fields.map((f) => `"${sanitizeIdent(f)}"`).join(', ');
    for (const r of rows) {
      const values = [sqlLiteral(r.id), ...table.columns.map((c) => sqlLiteral(r.data[c.field], c.type))];
      out.push(`INSERT INTO "${tableName}" (${colList}) VALUES (${values.join(', ')});`);
    }
  }
  return out.join('\n');
}

function renderColumnDef(c: ColumnSpec): string {
  const parts = [`"${sanitizeIdent(c.field)}"`, sqlTypeFor(c.type)];
  if (c.notnull) parts.push('NOT NULL');
  if (c.unique) parts.push('UNIQUE');
  return parts.join(' ');
}

function sqlTypeFor(t: ColumnType): string {
  switch (t) {
    case 'number':
      return 'NUMERIC';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      // Dates are serialized as 'YYYYMMDD' (see sqlLiteral) so a fixed-width
      // CHAR keeps downstream JOINs predictable.
      return 'CHAR(8)';
    case 'datetime':
      return 'TIMESTAMP';
    case 'string':
    default:
      return 'TEXT';
  }
}

function sqlLiteral(v: unknown, columnType?: ColumnType): string {
  if (v == null) return 'NULL';
  // `date` columns get a compact 'YYYYMMDD' literal. Stored values are
  // typically ISO strings ('2026-05-24') but Date objects and longer ISO
  // forms ('2026-05-24T14:30') are also handled.
  if (columnType === 'date') {
    if (typeof v === 'string' && v.trim() === '') return 'NULL';
    const ymd = toYyyymmdd(v);
    return ymd === null ? 'NULL' : quote(ymd);
  }
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return quote(v.toISOString());
  if (typeof v === 'string') return quote(v);
  return quote(JSON.stringify(v));
}

/**
 * Format any reasonable date input as 'YYYYMMDD'. Returns null when the input
 * is empty/unparseable so the caller can emit SQL NULL.
 *
 * Uses UTC components for `Date` instances — we don't want the user's local
 * timezone to shift the day forward or back when serializing.
 */
function toYyyymmdd(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) {
    return Number.isFinite(v.getTime()) ? ymdFromDate(v) : null;
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.length === 0) return null;
    // Cheap path: any ISO-ish string starts with YYYY-MM-DD.
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return `${m[1]}${m[2]}${m[3]}`;
    const d = new Date(s);
    return Number.isFinite(d.getTime()) ? ymdFromDate(d) : null;
  }
  return null;
}

function ymdFromDate(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function quote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function sanitizeIdent(s: string): string {
  let out = s.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return out || '_';
}
