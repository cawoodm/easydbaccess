import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import type { ProjectionSpec, Row, Table } from '@easydb/shared';
import { buildProjectionSelect } from '../../../packages/renderer/src/plugins/projection-sql.js';
import { computeProjection } from '../../../packages/renderer/src/plugins/projection-compute.js';
import { serializeTableAsSql } from '../../../packages/renderer/src/plugins/sql-export.js';

/**
 * These tests do not just eyeball the generated SQL — they RUN it against a real
 * SQLite database holding the same source rows and assert the result matches
 * `computeProjection` row-for-row. That is the only way to know the export
 * faithfully represents the join rather than merely looking plausible.
 *
 * The export is ANSI-flavoured (double-quoted identifiers, a trailing `LIMIT n`),
 * which SQLite runs as-is — so these tests execute exactly what the export emits.
 * The other dialects the builder can render are asserted on the string.
 */

// `node:sqlite` is newer than Vite's builtin-module list, so a static import is
// mis-resolved ("Failed to load url sqlite"). Requiring it at runtime keeps it
// out of Vite's module graph.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...a: unknown[]): void; all(): unknown[] };
    close(): void;
  };
};

const people = [
  { id: 'p1', name: 'Alice', deptId: 'd1' },
  { id: 'p2', name: 'Bob', deptId: 'd2' },
  { id: 'p3', name: 'Carol', deptId: 'd1' },
  { id: 'p4', name: 'Dan', deptId: 'd9' }, // no matching dept
];
const depts = [
  { id: 'd1', label: 'Sales', budget: 50 },
  { id: 'd2', label: 'Support', budget: 30 },
];

function db() {
  const d = new DatabaseSync(':memory:');
  d.exec('CREATE TABLE "People" ("id" TEXT, "name" TEXT, "deptId" TEXT)');
  d.exec('CREATE TABLE "Dept" ("id" TEXT, "label" TEXT, "budget" NUMERIC)');
  for (const p of people) {
    d.prepare('INSERT INTO "People" VALUES (?, ?, ?)').run(p.id, p.name, p.deptId);
  }
  for (const t of depts) {
    d.prepare('INSERT INTO "Dept" VALUES (?, ?, ?)').run(t.id, t.label, t.budget);
  }
  return d;
}

/** The same rows the provider would hand the grid. */
function computed(spec: ProjectionSpec): Array<Record<string, unknown>> {
  const asRows = (rows: Array<Record<string, unknown>>): Row[] => rows.map((data, i) => ({ id: `r${i}`, tableId: 't', data, updatedAt: 0 }));
  return computeProjection(spec, { p: asRows(people), d: asRows(depts) }).map((r) => r.data);
}

/** Run exactly what the export emits, and return the rows SQLite gives back. */
function executed(spec: ProjectionSpec) {
  const sql = buildProjectionSelect(spec, { tableNames: { p: 'People', d: 'Dept' } });
  const d = db();
  try {
    return d
      .prepare(sql.replace(/--[^\n]*/g, '').trim())
      .all()
      .map((r) => ({ ...(r as Record<string, unknown>) }));
  } finally {
    d.close();
  }
}

const leftJoin: ProjectionSpec = {
  version: 1,
  sources: [
    { alias: 'p', tableName: 'People' },
    { alias: 'd', tableName: 'Dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
  ],
  columns: [
    { field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } },
    { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
  ],
};

describe('the exported SELECT reproduces the projection', () => {
  it('LEFT JOIN — same rows, same order, unmatched base row kept', () => {
    expect(executed(leftJoin)).toEqual(computed(leftJoin));
    // Sanity: this fixture really does exercise the null side.
    expect(computed(leftJoin)).toContainEqual({ name: 'Dan', dept: null });
  });

  it('INNER JOIN — unmatched base rows dropped by both', () => {
    const spec: ProjectionSpec = {
      ...leftJoin,
      sources: [leftJoin.sources[0]!, { ...leftJoin.sources[1]!, join: { type: 'inner', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } }],
    };
    expect(executed(spec)).toEqual(computed(spec));
    expect(executed(spec)).toHaveLength(3); // Dan has no dept
  });

  it('filters — the same rows survive the WHERE clause', () => {
    const spec: ProjectionSpec = { ...leftJoin, filters: { dept: 'sal' } };
    expect(executed(spec)).toEqual(computed(spec));
    expect(executed(spec).map((r) => r.name)).toEqual(['Alice', 'Carol']);
  });

  it('row limit — the cap applies identically', () => {
    const spec: ProjectionSpec = { ...leftJoin, limit: 2 };
    expect(executed(spec)).toEqual(computed(spec));
    expect(executed(spec)).toHaveLength(2);
  });

  it('a multi-key join ANDs every key in both engines', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'p', tableName: 'People' },
        {
          alias: 'd',
          tableName: 'Dept',
          join: {
            type: 'inner',
            on: [
              { field: 'id', eqAlias: 'p', eqField: 'deptId' },
              { field: 'label', eqAlias: 'p', eqField: 'name' }, // never true
            ],
          },
        },
      ],
      columns: [{ field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } }],
    };
    expect(executed(spec)).toEqual(computed(spec));
    expect(executed(spec)).toHaveLength(0);
  });

  it('a self-join (the same table twice) resolves the same both ways', () => {
    const spec: ProjectionSpec = {
      version: 1,
      sources: [
        { alias: 'p', tableName: 'People' },
        { alias: 'd', tableName: 'Dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
      ],
      columns: [
        { field: 'who', from: { kind: 'source', alias: 'p', field: 'name' } },
        { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
        { field: 'budget', from: { kind: 'source', alias: 'd', field: 'budget' } },
      ],
    };
    expect(executed(spec)).toEqual(computed(spec));
  });
});

describe('buildProjectionSelect: SQL text', () => {
  const names = { p: 'People', d: 'Dept' };

  it('renders the row cap as a trailing LIMIT n by default (ANSI-flavoured)', () => {
    const sql = buildProjectionSelect({ ...leftJoin, limit: 5 }, { tableNames: names });
    expect(sql).toContain('LIMIT 5');
    expect(sql).not.toContain('TOP');
  });

  it('can also render the SQL:2008 FETCH FIRST and the SQL Server TOP forms', () => {
    expect(buildProjectionSelect({ ...leftJoin, limit: 5 }, { tableNames: names, limitStyle: 'fetch' })).toContain('FETCH FIRST 5 ROWS ONLY');
    const top = buildProjectionSelect({ ...leftJoin, limit: 5 }, { tableNames: names, limitStyle: 'top' });
    expect(top).toContain('SELECT TOP 5');
    expect(top).not.toContain('LIMIT');
  });

  it('emits no cap at all without a limit', () => {
    const none = buildProjectionSelect(leftJoin, { tableNames: names });
    expect(none).not.toContain('TOP');
    expect(none).not.toContain('LIMIT');
    expect(none).not.toContain('FETCH');
  });

  it('aliases every source and spells out the join', () => {
    const sql = buildProjectionSelect(leftJoin, { tableNames: { p: 'People', d: 'Dept' } });
    expect(sql).toContain('FROM "People" AS "p"');
    expect(sql).toContain('LEFT JOIN "Dept" AS "d" ON "d"."id" = "p"."deptId"');
    expect(sql).toContain('"p"."name" AS "name"');
  });

  it('flags a computed column instead of pretending it translated', () => {
    const spec: ProjectionSpec = {
      ...leftJoin,
      columns: [...leftJoin.columns, { field: 'greeting', from: { kind: 'script', script: 'function render(r){return "hi";}' } }],
      filters: { greeting: 'hi' },
    };
    const sql = buildProjectionSelect(spec, { tableNames: { p: 'People', d: 'Dept' } });
    expect(sql).toContain('NULL AS "greeting"');
    expect(sql).toContain('no SQL equivalent');
    // A filter on it cannot become SQL either — say so rather than drop it.
    expect(sql).toContain('enforced in-app only');
    expect(sql).not.toMatch(/WHERE[\s\S]*greeting/);
  });

  it('adds ORDER BY so a TOP n is deterministic', () => {
    const sql = buildProjectionSelect({ ...leftJoin, limit: 2 }, { tableNames: { p: 'People', d: 'Dept' }, orderBy: [{ field: 'name', asc: false }] });
    expect(sql).toContain('ORDER BY "p"."name" DESC');
  });

  it('escapes a quote in a filter value', () => {
    const sql = buildProjectionSelect({ ...leftJoin, filters: { name: "O'Brien" } }, { tableNames: { p: 'People', d: 'Dept' } });
    expect(sql).toContain("'%o''brien%'");
  });
});

describe('serializeTableAsSql for a projection table', () => {
  const projTable: Table = {
    id: 'proj',
    workspaceId: 'ws',
    name: 'Staff by Dept',
    code: 'staff-by-dept',
    columns: [
      { field: 'name', label: 'Name', type: 'string' },
      { field: 'dept', label: 'Dept', type: 'string' },
    ],
    view: 'table',
    updatedAt: 0,
    sortBy: [{ field: 'name', asc: true }],
    source: { type: 'projection', config: { ...leftJoin, limit: 10 } as unknown as Record<string, unknown> },
  };

  it('exports the query behind the projection, not a dump of derived rows', () => {
    const sql = serializeTableAsSql(projTable, []);
    expect(sql).toContain('-- projection: Staff by Dept');
    expect(sql).toContain('LIMIT 10');
    // The SQL identifier is the one `renderTable` declares for that source
    // table (its slug/code), not the display name — otherwise the exported
    // query would not run against the exported dump.
    expect(sql).toContain('FROM "people" AS "p"');
    expect(sql).toContain('ORDER BY "p"."name" ASC');
    // No CREATE TABLE / INSERT: a projection stores nothing.
    expect(sql).not.toContain('CREATE TABLE');
    expect(sql).not.toContain('INSERT INTO');
  });

  it('still emits CREATE TABLE + INSERT for an ordinary table', () => {
    const plain: Table = { ...projTable, name: 'People', code: 'people' };
    delete (plain as { source?: unknown }).source;
    const sql = serializeTableAsSql(plain, [{ id: 'r1', tableId: 'x', data: { name: 'Alice', dept: 'Sales' }, updatedAt: 0 }]);
    expect(sql).toContain('CREATE TABLE "people"');
    expect(sql).toContain('INSERT INTO "people"');
    expect(sql).not.toContain('LIMIT');
  });
});
