// packages/renderer/src/plugins/projection-sql.ts
//
// Render a Projection as the SELECT that defines it — the honest SQL form of a
// virtual table. A projection IS a query, so its `.sql` export is that query
// rather than a dump of derived rows.
//
// Faithfulness is the whole point, so two rules are absolute:
//  - everything the spec expresses (join type, every ON key, the column list,
//    filters, the row cap) appears in the SQL;
//  - anything SQL CANNOT express (a computed column's JavaScript, a filter on
//    one) is called out in a comment rather than silently dropped, so nobody
//    reads the export as equivalent when it isn't.
//
// Pure and DOM-free; `projection-sql.test.ts` executes the output against a real
// SQLite database and compares it row-for-row with `computeProjection`.

import type { ProjectionSpec, SortSpec } from '@easydb/shared';

export interface ProjectionSqlOpts {
  /** Source alias → the SQL table name it reads from. */
  tableNames: Record<string, string>;
  /**
   * How to cap rows:
   *  - `limit` (default) — a trailing `LIMIT n`. What the export emits, because
   *    it is the only spelling that runs on BOTH targets this exporter promises
   *    (PostgreSQL and SQLite — see the header `serializeWorkspaceAsSql` writes).
   *  - `fetch` — `FETCH FIRST n ROWS ONLY`, the strict SQL:2008 form. Standard,
   *    and supported by PostgreSQL / DB2 / Oracle / SQL Server 2012+ — but NOT
   *    by SQLite.
   *  - `top` — `SELECT TOP n` (SQL Server / HANA / Sybase).
   */
  limitStyle?: 'limit' | 'fetch' | 'top';
  /** ORDER BY keys, named by OUTPUT field — makes a row cap deterministic. */
  orderBy?: SortSpec[] | undefined;
}

/** Quote an identifier, matching sql-export's `sanitizeIdent` escaping. */
function ident(s: string): string {
  let out = s.replace(/[^a-zA-Z0-9_]/g, '_');
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return `"${out || '_'}"`;
}

function quoteText(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** The SQL expression a projection column reads from, or null when it is computed. */
function columnExpr(spec: ProjectionSpec, outField: string): { expr: string; computed: false } | { expr: null; computed: true } | null {
  const col = spec.columns.find((c) => c.field === outField);
  if (!col) return null;
  if (col.from.kind === 'script') return { expr: null, computed: true };
  return { expr: `${ident(col.from.alias)}.${ident(col.from.field)}`, computed: false };
}

/**
 * Build the SELECT statement for a projection. Returns SQL ending in `;`.
 */
export function buildProjectionSelect(spec: ProjectionSpec, opts: ProjectionSqlOpts): string {
  const base = spec.sources[0];
  if (!base) return '-- projection has no source table; nothing to select.\n';
  const style = opts.limitStyle ?? 'limit';
  const limit = spec.limit != null && spec.limit > 0 ? Math.floor(spec.limit) : null;

  // -- SELECT list ---------------------------------------------------------
  const selected: string[] = [];
  for (const c of spec.columns) {
    if (c.from.kind === 'source') {
      selected.push(`  ${ident(c.from.alias)}.${ident(c.from.field)} AS ${ident(c.field)}`);
    } else {
      // A JavaScript expression has no SQL equivalent. Emit a typed NULL so the
      // column still exists in the result shape, and say why it is empty.
      selected.push(`  NULL AS ${ident(c.field)} -- computed in-app by a script; no SQL equivalent`);
    }
  }
  if (selected.length === 0) selected.push('  *');

  const top = limit != null && style === 'top' ? ` TOP ${limit}` : '';
  const lines: string[] = [`SELECT${top}`, selected.join(',\n')];

  // -- FROM + JOINs --------------------------------------------------------
  const baseTable = opts.tableNames[base.alias] ?? base.tableName;
  lines.push(`FROM ${ident(baseTable)} AS ${ident(base.alias)}`);
  for (const s of spec.sources.slice(1)) {
    const name = opts.tableNames[s.alias] ?? s.tableName;
    if (!s.join) {
      // No join predicate: a cross join is what that means, and saying so is
      // better than emitting a silent one.
      lines.push(`CROSS JOIN ${ident(name)} AS ${ident(s.alias)}`);
      continue;
    }
    const kind = s.join.type === 'inner' ? 'INNER JOIN' : 'LEFT JOIN';
    const on = s.join.on.map((k) => `${ident(s.alias)}.${ident(k.field)} = ${ident(k.eqAlias)}.${ident(k.eqField)}`).join(' AND ');
    lines.push(`${kind} ${ident(name)} AS ${ident(s.alias)} ON ${on || '1 = 1'}`);
  }

  // -- WHERE (the grid's case-insensitive "contains" filters) --------------
  const conds: string[] = [];
  const notes: string[] = [];
  for (const [field, needle] of Object.entries(spec.filters ?? {})) {
    if (!needle) continue;
    const src = columnExpr(spec, field);
    if (!src) continue;
    if (src.computed) {
      notes.push(`-- filter on ${ident(field)} (${quoteText(needle)}) applies to a computed column; enforced in-app only`);
      continue;
    }
    // The SELECT alias is not referenceable in WHERE on every engine, so filter
    // the underlying expression.
    conds.push(`LOWER(${src.expr}) LIKE ${quoteText(`%${needle.toLowerCase()}%`)}`);
  }
  if (conds.length > 0) lines.push(`WHERE ${conds.join('\n  AND ')}`);

  // -- ORDER BY ------------------------------------------------------------
  const order = (opts.orderBy ?? [])
    .map((k) => {
      const src = columnExpr(spec, k.field);
      if (!src || src.computed) return null;
      return `${src.expr} ${k.asc ? 'ASC' : 'DESC'}`;
    })
    .filter((s): s is string => s !== null);
  if (order.length > 0) lines.push(`ORDER BY ${order.join(', ')}`);

  const tail = limit == null ? '' : style === 'limit' ? `\nLIMIT ${limit}` : style === 'fetch' ? `\nFETCH FIRST ${limit} ROWS ONLY` : ''; // 'top' already went into the SELECT clause
  return `${lines.join('\n')}${tail};\n${notes.length > 0 ? `${notes.join('\n')}\n` : ''}`;
}
