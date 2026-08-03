// packages/renderer/src/plugins/sql-parse.ts
//
// Read a `.sql` script back into tables and projections — the inverse of
// sql-export.ts.
//
// SCOPE, stated plainly: this understands the SQL this app WRITES, plus the
// ordinary hand-written forms of the same statements. It is not a general SQL
// engine and does not pretend to be one: anything it cannot model is collected
// in `unsupported` and reported to the user rather than silently dropped. A
// statement that half-parses is never half-imported.
//
// Understood:
//   CREATE TABLE "t" ("col" TYPE [NOT NULL] [UNIQUE] [PRIMARY KEY], …)
//   INSERT INTO "t" ("a","b") VALUES (…), (…)
//   SELECT [TOP n] <cols> FROM t [AS] a [LEFT|INNER|CROSS JOIN u [AS] b ON …]*
//          [WHERE LOWER(x) LIKE '%v%' [AND …]] [ORDER BY …] [LIMIT n | FETCH FIRST n ROWS ONLY]
//   CREATE VIEW "v" AS SELECT …            (the SELECT becomes a projection)
//   -- projection: <name>                  (names the SELECT that follows)
//
// Pure and DOM-free — `sql-parse.test.ts` round-trips it against sql-export's
// own output, which is the only check that matters for our own dumps.

import type { ColumnSpec, ColumnType, ProjectionColumn, ProjectionSource, ProjectionSpec, SortSpec } from '@easydb/shared';
import { isUnsafeIntegerText } from '../import/big-numbers.js';

export interface ParsedSqlTable {
  name: string;
  columns: ColumnSpec[];
  rows: Array<Record<string, unknown>>;
}

export interface ParsedSqlProjection {
  name: string;
  spec: ProjectionSpec;
  /** Sort lifted from ORDER BY — presentation, so it lands on the table. */
  sortBy?: SortSpec[] | undefined;
}

export interface ParsedSql {
  tables: ParsedSqlTable[];
  projections: ParsedSqlProjection[];
  /** Statements (or clauses) this parser could not model, verbatim-ish. */
  unsupported: string[];
}

/** The synthetic key sql-export adds; it is a row id, not a user column. */
const ROW_ID_COLUMN = '__id';

// -- lexing ----------------------------------------------------------------

interface Statement {
  sql: string;
  /** `-- projection: X` seen immediately before this statement. */
  name?: string | undefined;
}

/**
 * Split a script into statements on `;`, ignoring semicolons inside string
 * literals, quoted identifiers and comments, and remembering the
 * `-- projection:` label sql-export writes above a projection's SELECT.
 */
export function splitStatements(text: string): Statement[] {
  const out: Statement[] = [];
  let buf = '';
  let pendingName: string | undefined;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "'" || ch === '"') {
      const end = copyQuoted(text, i, ch);
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '-' && next === '-') {
      let line = '';
      i += 2;
      while (i < text.length && text[i] !== '\n') line += text[i++];
      const m = /^\s*projection:\s*(.+?)\s*$/i.exec(line);
      // A label belongs to the statement it precedes, not one it trails.
      if (m?.[1] && buf.trim() === '') pendingName = m[1];
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === ';') {
      if (buf.trim()) out.push({ sql: buf.trim(), ...(pendingName ? { name: pendingName } : {}) });
      buf = '';
      pendingName = undefined;
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) out.push({ sql: buf.trim(), ...(pendingName ? { name: pendingName } : {}) });
  return out;
}

/**
 * Index just past the quoted run starting at `start` (whose character is
 * `quote`), honouring the doubled-quote escape both SQL string literals and
 * quoted identifiers use.
 */
function copyQuoted(s: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === quote) {
      if (s[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return s.length;
}

/** Strip surrounding double quotes / brackets / backticks from an identifier. */
function unquote(s: string): string {
  const t = s.trim();
  if (/^".*"$/s.test(t)) return t.slice(1, -1).replace(/""/g, '"');
  if (/^\[.*\]$/s.test(t)) return t.slice(1, -1);
  if (/^`.*`$/s.test(t)) return t.slice(1, -1);
  return t;
}

/**
 * Split `s` wherever `match` reports a separator, but only at paren depth 0 and
 * never inside a string literal or a quoted identifier. `match` returns the
 * length of the separator it found, or 0.
 */
function splitOn(s: string, match: (s: string, i: number) => number): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      const end = copyQuoted(s, i, ch);
      buf += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0) {
      const n = match(s, i);
      if (n > 0) {
        out.push(buf);
        buf = '';
        i += n;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  out.push(buf);
  return out;
}

/** Split on a literal separator (e.g. `,`) at top level. */
function splitTop(s: string, sep: string): string[] {
  return splitOn(s, (t, i) => (t.startsWith(sep, i) ? sep.length : 0));
}

/**
 * Split on a bare SQL keyword (`AND`, `OR`) at top level, case-insensitively.
 * A plain `split(/\s+AND\s+/i)` would also cut a filter value that happens to
 * contain the word — `LIKE '%salt and pepper%'` really does occur.
 */
function splitKeyword(s: string, keyword: string): string[] {
  const re = new RegExp(`^\\s+${keyword}\\s+`, 'i');
  return splitOn(s, (t, i) => {
    if (!/\s/.test(t[i] ?? '')) return 0;
    return re.exec(t.slice(i, i + keyword.length + 32))?.[0].length ?? 0;
  });
}

/** The `( … )` body of the first balanced paren group, or null. */
function parenBody(s: string): string | null {
  const start = s.indexOf('(');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      i = copyQuoted(s, i, ch) - 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return s.slice(start + 1, i);
    }
  }
  return null;
}

// -- values ----------------------------------------------------------------

/** Parse one SQL literal into a JS value. */
export function parseLiteral(raw: string): unknown {
  const t = raw.trim();
  if (/^null$/i.test(t)) return null;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  if (/^'[\s\S]*'$/.test(t)) return t.slice(1, -1).replace(/''/g, "'");
  // An integer past 2^53 stays text: `Number` would round it and the digits of
  // an id are the id (see import/big-numbers.ts).
  if (isUnsafeIntegerText(t)) return t;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return t; // an expression we do not evaluate — keep the text
}

/** Map a SQL column type onto the app's ColumnType (inverse of sqlTypeFor). */
export function sqlTypeToColumnType(sqlType: string): ColumnType {
  const t = sqlType.toUpperCase();
  if (/BOOL/.test(t)) return 'boolean';
  if (/TIMESTAMP|DATETIME/.test(t)) return 'datetime';
  // Bare DATE only — sql-export writes dates as CHAR(8), which is
  // indistinguishable from a real fixed-width string, so those come back text.
  if (/^DATE\b/.test(t)) return 'date';
  if (/INT|NUMERIC|DECIMAL|REAL|DOUBLE|FLOAT|MONEY/.test(t)) return 'number';
  return 'string';
}

// -- statements ------------------------------------------------------------

function parseCreateTable(sql: string): ParsedSqlTable | null {
  const m = /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[^\s(]+)/i.exec(sql);
  if (!m?.[1]) return null;
  const body = parenBody(sql);
  if (body == null) return null;
  const columns: ColumnSpec[] = [];
  for (const part of splitTop(body, ',')) {
    const def = part.trim();
    if (!def) continue;
    // Table-level constraints are not columns.
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(def)) continue;
    const cm = /^("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[A-Za-z_][\w$]*)\s*([\s\S]*)$/.exec(def);
    if (!cm?.[1]) continue;
    const field = unquote(cm[1]);
    if (field === ROW_ID_COLUMN) continue; // the exporter's row-id key, not data
    const rest = cm[2] ?? '';
    const typeWord = /^([A-Za-z]+(?:\s*\([^)]*\))?)/.exec(rest.trim())?.[1] ?? 'TEXT';
    const col: ColumnSpec = { field, label: field, type: sqlTypeToColumnType(typeWord) };
    if (/\bNOT\s+NULL\b/i.test(rest)) col.notnull = true;
    if (/\bUNIQUE\b/i.test(rest) || /\bPRIMARY\s+KEY\b/i.test(rest)) col.unique = true;
    columns.push(col);
  }
  return { name: unquote(m[1]), columns, rows: [] };
}

function parseInsert(sql: string): { table: string; rows: Array<Record<string, unknown>> } | null {
  const m = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[^\s(]+)\s*(\([\s\S]*?\))?\s*VALUES\s*([\s\S]+)$/i.exec(sql);
  if (!m?.[1]) return null;
  const table = unquote(m[1]);
  const cols = m[2] ? splitTop(m[2].slice(1, -1), ',').map((c) => unquote(c)) : [];
  const rows: Array<Record<string, unknown>> = [];
  // One or more `( … )` tuples, comma-separated.
  let rest = (m[3] ?? '').trim();
  while (rest.startsWith('(')) {
    const body = parenBody(rest);
    if (body == null) break;
    const values = splitTop(body, ',').map((v) => parseLiteral(v));
    const row: Record<string, unknown> = {};
    values.forEach((v, i) => {
      const key = cols[i] ?? `col${i + 1}`;
      if (key !== ROW_ID_COLUMN) row[key] = v;
    });
    rows.push(row);
    rest = rest.slice(body.length + 2).trim();
    if (rest.startsWith(',')) rest = rest.slice(1).trim();
  }
  return { table, rows };
}

/** `<table> [AS] <alias>` → both, defaulting the alias to the table name. */
function parseTableRef(ref: string): { table: string; alias: string } {
  const m = /^\s*("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[^\s]+)(?:\s+(?:AS\s+)?("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[^\s]+))?\s*$/i.exec(ref);
  if (!m?.[1]) return { table: '', alias: '' };
  const table = unquote(m[1]);
  return { table, alias: m[2] ? unquote(m[2]) : table };
}

/** A dotted reference (`"p"."name"` or `name`) split into its unquoted parts. */
function dotted(ref: string): string[] {
  return splitTop(ref, '.').map(unquote);
}

/** Which source owns an unqualified field, given what each source's table holds. */
function ownerOf(field: string, sources: ProjectionSource[], schema: Map<string, string[]>): string {
  const owners = sources.filter((s) => (schema.get(s.tableName.toLowerCase()) ?? []).includes(field));
  // Prefer the base when it qualifies, so `SELECT id FROM a JOIN b` reads the
  // way SQL's own scoping rules would resolve an unambiguous name.
  if (owners.some((s) => s.alias === sources[0]?.alias)) return sources[0]!.alias;
  return (owners.length === 1 ? owners[0]?.alias : undefined) ?? sources[0]?.alias ?? '';
}

/**
 * Peel the trailing clauses off everything after `FROM`, from the END inwards,
 * so what remains is only the table list. Done in this order because each
 * clause can only be preceded by the ones before it.
 */
function peelTailClauses(afterFrom: string): { from: string; limit?: number | undefined; orderBy?: string | undefined; where?: string | undefined } {
  let tail = afterFrom;
  let limit: number | undefined;
  const fetchM = /\s+FETCH\s+FIRST\s+(\d+)\s+ROWS?\s+ONLY\s*$/i.exec(tail);
  if (fetchM) {
    limit = Number(fetchM[1]);
    tail = tail.slice(0, fetchM.index);
  }
  const limitM = /\s+LIMIT\s+(\d+)\s*$/i.exec(tail);
  if (limitM) {
    limit = Number(limitM[1]);
    tail = tail.slice(0, limitM.index);
  }
  let orderBy: string | undefined;
  const orderM = /\s+ORDER\s+BY\s+([\s\S]+)$/i.exec(tail);
  if (orderM?.[1]) {
    orderBy = orderM[1];
    tail = tail.slice(0, orderM.index);
  }
  let where: string | undefined;
  const whereM = /\s+WHERE\s+([\s\S]+)$/i.exec(tail);
  if (whereM?.[1]) {
    where = whereM[1];
    tail = tail.slice(0, whereM.index);
  }
  return { from: tail, limit, orderBy, where };
}

/** One `ON a.x = b.y [AND …]` chain, as spec join keys. */
function parseOnKeys(
  onClause: string,
  ref: { table: string; alias: string },
  known: ProjectionSource[],
  schema: Map<string, string[]>,
  unsupported: string[],
): Array<{ field: string; eqAlias: string; eqField: string }> {
  const on: Array<{ field: string; eqAlias: string; eqField: string }> = [];
  const aliasOf = (p: string[]): string => (p.length === 2 ? (p[0] ?? '') : ownerOf(p[0] ?? '', known, schema));
  for (const cond of splitKeyword(onClause, 'AND')) {
    const eq = /^\s*([\w".$[\]`]+)\s*=\s*([\w".$[\]`]+)\s*$/.exec(cond);
    if (!eq?.[1] || !eq[2]) {
      unsupported.push(`ON ${cond.trim()}`);
      continue;
    }
    const left = dotted(eq[1]);
    const right = dotted(eq[2]);
    // The key belonging to THIS source goes in `field`; the other side names an
    // already-introduced source it matches.
    const leftIsMine = aliasOf(left) === ref.alias;
    const mine = leftIsMine ? left : right;
    const other = leftIsMine ? right : left;
    if (aliasOf(mine) !== ref.alias) {
      unsupported.push(`ON ${cond.trim()} — neither side names ${ref.alias}`);
      continue;
    }
    on.push({
      field: mine.length === 2 ? (mine[1] ?? '') : (mine[0] ?? ''),
      eqAlias: other.length === 2 ? (other[0] ?? '') : aliasOf(other),
      eqField: other.length === 2 ? (other[1] ?? '') : (other[0] ?? ''),
    });
  }
  return on;
}

/** `FROM t AS a [LEFT|INNER|… JOIN u AS b ON …]*` → the spec's source list. */
function parseFromClause(from: string, schema: Map<string, string[]>, unsupported: string[]): ProjectionSource[] | null {
  const joinRe = /\s+(LEFT|RIGHT|FULL|INNER|CROSS)(?:\s+OUTER)?\s+JOIN\s+|\s+JOIN\s+/gi;
  const pieces: string[] = [];
  const kinds: string[] = [];
  let last = 0;
  for (let m = joinRe.exec(from); m; m = joinRe.exec(from)) {
    pieces.push(from.slice(last, m.index));
    kinds.push((m[1] ?? 'INNER').toUpperCase());
    last = m.index + m[0].length;
  }
  pieces.push(from.slice(last));

  const base = parseTableRef(pieces[0] ?? '');
  if (!base.table) return null;
  const sources: ProjectionSource[] = [{ alias: base.alias, tableName: base.table }];

  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i] ?? '';
    const onM = /\s+ON\s+([\s\S]+)$/i.exec(piece);
    const ref = parseTableRef(onM ? piece.slice(0, onM.index) : piece);
    if (!ref.table) continue;
    const kind = kinds[i - 1] ?? 'INNER';
    if (kind === 'CROSS' || !onM?.[1]) {
      // A ProjectionSpec join is an equality predicate; a cross product is not
      // one, so say so rather than invent keys.
      unsupported.push(`${kind} JOIN ${ref.table} — no ON predicate to model`);
      sources.push({ alias: ref.alias, tableName: ref.table });
      continue;
    }
    if (kind === 'RIGHT' || kind === 'FULL') {
      // Only INNER and LEFT exist in the spec; the others would silently change
      // which rows survive, so the substitution is stated rather than assumed.
      unsupported.push(`${kind} JOIN ${ref.table} — imported as LEFT JOIN (the closest a projection can express)`);
    }
    const known = [...sources, { alias: ref.alias, tableName: ref.table }];
    sources.push({
      alias: ref.alias,
      tableName: ref.table,
      join: { type: kind === 'INNER' ? 'inner' : 'left', on: parseOnKeys(onM[1], ref, known, schema, unsupported) },
    });
  }
  return sources;
}

/** The SELECT list → the spec's output columns. */
function parseSelectList(selectList: string, sources: ProjectionSource[], schema: Map<string, string[]>, unsupported: string[]): ProjectionColumn[] {
  const columns: ProjectionColumn[] = [];
  for (const item of splitTop(selectList, ',')) {
    const it = item.trim();
    if (!it) continue;
    if (it === '*') {
      unsupported.push('SELECT * — a projection needs its columns listed');
      continue;
    }
    const asM = /^([\s\S]*?)\s+AS\s+("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[\w$]+)$/i.exec(it);
    const expr = (asM?.[1] ?? it).trim();
    const parts = dotted(expr);
    const out = unquote(asM?.[2] ?? parts[parts.length - 1] ?? expr);
    if (/^NULL$/i.test(expr)) {
      // What sql-export writes for a computed column: the script itself cannot
      // survive the trip, but the column should still exist to be re-scripted.
      columns.push({ field: out, from: { kind: 'script', script: COMPUTED_PLACEHOLDER } });
      continue;
    }
    if (parts.length === 2 && parts[0] && parts[1]) {
      columns.push({ field: out, from: { kind: 'source', alias: parts[0], field: parts[1] } });
    } else if (parts.length === 1 && parts[0] && /^[\w$]+$/.test(parts[0])) {
      columns.push({ field: out, from: { kind: 'source', alias: ownerOf(parts[0], sources, schema), field: parts[0] } });
    } else {
      unsupported.push(`SELECT ${it} — expression not modelled`);
    }
  }
  return columns;
}

interface SelectClauses {
  columns: ProjectionColumn[];
  sources: ProjectionSource[];
  schema: Map<string, string[]>;
  unsupported: string[];
}

/** WHERE → the grid's filters, but only the `LOWER(x) LIKE '%v%'` shape we emit. */
function parseWhereFilters(where: string | undefined, c: SelectClauses): Record<string, string> {
  const filters: Record<string, string> = {};
  if (!where) return filters;
  for (const cond of splitKeyword(where, 'AND')) {
    const like = /^\s*LOWER\(\s*([\w".$[\]`]+)\s*\)\s+LIKE\s+'%([\s\S]*)%'\s*$/i.exec(cond.trim());
    const col = like?.[1] ? columnFor(c.columns, dotted(like[1]), c.sources, c.schema) : undefined;
    if (!like || !col) {
      c.unsupported.push(`WHERE ${cond.trim()}`);
      continue;
    }
    filters[col.field] = (like[2] ?? '').replace(/''/g, "'");
  }
  return filters;
}

/**
 * ORDER BY → `Table.sortBy`, which names OUTPUT fields — so each key is
 * resolved back through the SELECT list rather than taken verbatim.
 */
function parseOrderBy(orderBy: string | undefined, c: SelectClauses): SortSpec[] {
  const sortBy: SortSpec[] = [];
  for (const k of splitTop(orderBy ?? '', ',')) {
    const t = k.trim();
    if (!t) continue;
    const [expr, dir] = t.split(/\s+/);
    const col = columnFor(c.columns, dotted(expr ?? ''), c.sources, c.schema);
    if (!col) {
      c.unsupported.push(`ORDER BY ${t}`);
      continue;
    }
    sortBy.push({ field: col.field, asc: !/^DESC$/i.test(dir ?? '') });
  }
  return sortBy;
}

function parseSelect(sql: string, fallbackName: string, schema: Map<string, string[]>, label?: string): { projection: ParsedSqlProjection; unsupported: string[] } | null {
  const unsupported: string[] = [];
  const flat = sql.replace(/\s+/g, ' ').trim();
  const head = /^SELECT\s+(?:TOP\s+(\d+)\s+)?([\s\S]+?)\s+FROM\s+([\s\S]+)$/i.exec(flat);
  if (!head) return null;

  const { from, limit: tailLimit, orderBy, where } = peelTailClauses(head[3] ?? '');
  const limit = tailLimit ?? (head[1] ? Number(head[1]) : undefined);

  const sources = parseFromClause(from, schema, unsupported);
  if (!sources) return null;
  const columns = parseSelectList(head[2] ?? '', sources, schema, unsupported);
  const clauses: SelectClauses = { columns, sources, schema, unsupported };
  const filters = parseWhereFilters(where, clauses);
  const sortBy = parseOrderBy(orderBy, clauses);

  const spec: ProjectionSpec = { version: 1, sources, columns };
  if (Object.keys(filters).length > 0) spec.filters = filters;
  if (limit != null && limit > 0) spec.limit = limit;

  return {
    projection: { name: label || fallbackName, spec, ...(sortBy.length > 0 ? { sortBy } : {}) },
    unsupported,
  };
}

/**
 * The script a `NULL AS x` column comes back as. The original JavaScript is not
 * in the SQL — nothing could put it there — so the column is preserved as an
 * empty computed one for the user to fill in, and says so.
 */
const COMPUTED_PLACEHOLDER = [
  '// This column was computed in-app; SQL carried only its NAME,',
  '// not its script. Re-enter the expression here.',
  'function render(row) {',
  '  return null;',
  '}',
].join('\n');

/**
 * The projection column a WHERE/ORDER BY reference points at — matched on the
 * SOURCE expression (`"p"."name"`) or, failing that, the output field name.
 */
function columnFor(columns: ProjectionColumn[], ref: string[], sources: ProjectionSource[], schema: Map<string, string[]>): ProjectionColumn | undefined {
  const alias = ref.length === 2 ? ref[0] : ownerOf(ref[0] ?? '', sources, schema);
  const field = ref.length === 2 ? ref[1] : ref[0];
  return columns.find((c) => c.from.kind === 'source' && c.from.alias === alias && c.from.field === field) ?? columns.find((c) => c.field === field);
}

// -- entry point -----------------------------------------------------------

/** Parse a whole `.sql` script into tables + projections. */
export function parseSqlScript(text: string): ParsedSql {
  const tables = new Map<string, ParsedSqlTable>();
  const projections: ParsedSqlProjection[] = [];
  const unsupported: string[] = [];
  /** table name (lowercased) → its fields, so unqualified references resolve. */
  const schema = new Map<string, string[]>();
  const remember = (t: ParsedSqlTable): void => {
    schema.set(
      t.name.toLowerCase(),
      t.columns.map((c) => c.field),
    );
  };

  for (const st of splitStatements(text)) {
    const sql = st.sql;
    if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(sql)) {
      const t = parseCreateTable(sql);
      if (!t) {
        unsupported.push(firstLine(sql));
        continue;
      }
      // A re-declared table keeps rows already read for it (DROP/CREATE around
      // an INSERT block is how our own dumps are shaped).
      const prior = tables.get(t.name);
      tables.set(t.name, { ...t, rows: prior?.rows ?? [] });
      remember(t);
      continue;
    }
    if (/^INSERT\s+/i.test(sql)) {
      const ins = parseInsert(sql);
      if (!ins) {
        unsupported.push(firstLine(sql));
        continue;
      }
      const existing = tables.get(ins.table);
      if (existing) existing.rows.push(...ins.rows);
      else {
        // An INSERT for a table we never saw defined: infer from its values.
        const t = { name: ins.table, columns: inferColumns(ins.rows), rows: ins.rows };
        tables.set(ins.table, t);
        remember(t);
      }
      continue;
    }
    if (/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\b/i.test(sql)) {
      const vm = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+("(?:[^"]|"")*"|\[[^\]]*\]|`[^`]*`|[^\s(]+)\s+AS\s+(SELECT[\s\S]+)$/i.exec(sql);
      const viewName = vm?.[1] ? unquote(vm[1]) : '';
      const parsed = vm?.[2] ? parseSelect(vm[2], viewName || 'view', schema, viewName) : null;
      if (parsed) {
        projections.push(parsed.projection);
        unsupported.push(...parsed.unsupported);
      } else unsupported.push(firstLine(sql));
      continue;
    }
    if (/^SELECT\b/i.test(sql)) {
      const parsed = parseSelect(sql, '', schema, st.name);
      if (parsed) {
        projections.push(parsed.projection);
        unsupported.push(...parsed.unsupported);
      } else unsupported.push(firstLine(sql));
      continue;
    }
    // Transaction/DDL noise we can safely ignore rather than report as a loss.
    if (/^(BEGIN|START\s+TRANSACTION|COMMIT|END|DROP|PRAGMA|SET|USE|ANALYZE|VACUUM)\b/i.test(sql)) continue;
    unsupported.push(firstLine(sql));
  }

  // An unlabelled SELECT still needs a name; derive one from its base table.
  for (const p of projections) {
    if (!p.name) p.name = `${p.spec.sources[0]?.tableName ?? 'query'} view`;
  }
  return { tables: [...tables.values()], projections, unsupported };
}

function firstLine(sql: string): string {
  const line = sql.split('\n')[0]?.trim() ?? sql;
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

function inferColumns(rows: Array<Record<string, unknown>>): ColumnSpec[] {
  const fields: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!fields.includes(k)) fields.push(k);
  return fields.map((field) => {
    const values = rows.map((r) => r[field]).filter((v) => v != null);
    const type: ColumnType = values.length === 0 ? 'string' : values.every((v) => typeof v === 'number') ? 'number' : values.every((v) => typeof v === 'boolean') ? 'boolean' : 'string';
    return { field, label: field, type };
  });
}
