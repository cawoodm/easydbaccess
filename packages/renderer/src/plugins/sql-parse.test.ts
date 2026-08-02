import { describe, expect, it } from 'vitest';
import type { ProjectionSpec, Row, Table } from '@easydb/shared';
import { parseLiteral, parseSqlScript, splitStatements, sqlTypeToColumnType } from './sql-parse.js';
import { serializeTableAsSql, serializeWorkspaceAsSql } from './sql-export.js';

/**
 * The test that actually matters is the ROUND TRIP: feed the parser what
 * sql-export writes and assert the same tables and the same ProjectionSpec come
 * back out. Everything else here covers hand-written SQL that is not ours.
 */

describe('splitStatements', () => {
  it('splits on semicolons but not inside literals, identifiers or comments', () => {
    const st = splitStatements(`
      -- a comment with ; in it
      INSERT INTO "t" ("a") VALUES ('x;y');
      /* block ; comment */
      SELECT "a b;c" FROM "t";
    `);
    expect(st.map((s) => s.sql)).toEqual([`INSERT INTO "t" ("a") VALUES ('x;y')`, `SELECT "a b;c" FROM "t"`]);
  });

  it('attaches a `-- projection:` label to the statement it precedes', () => {
    const st = splitStatements(`SELECT 1;\n-- projection: Staff by Dept\nSELECT "p"."x" FROM "p";`);
    expect(st[0]?.name).toBeUndefined();
    expect(st[1]?.name).toBe('Staff by Dept');
  });
});

describe('parseLiteral / sqlTypeToColumnType', () => {
  it('reads the literal forms sql-export writes', () => {
    expect(parseLiteral('NULL')).toBeNull();
    expect(parseLiteral('TRUE')).toBe(true);
    expect(parseLiteral('42')).toBe(42);
    expect(parseLiteral('-1.5e3')).toBe(-1500);
    expect(parseLiteral("'O''Brien'")).toBe("O'Brien");
  });

  it('inverts sqlTypeFor', () => {
    expect(sqlTypeToColumnType('NUMERIC')).toBe('number');
    expect(sqlTypeToColumnType('BOOLEAN')).toBe('boolean');
    expect(sqlTypeToColumnType('TIMESTAMP')).toBe('datetime');
    expect(sqlTypeToColumnType('TEXT')).toBe('string');
    // Dates are written as CHAR(8), which is indistinguishable from text.
    expect(sqlTypeToColumnType('CHAR(8)')).toBe('string');
    expect(sqlTypeToColumnType('DATE')).toBe('date');
  });
});

describe('CREATE TABLE + INSERT', () => {
  const script = `
    BEGIN;
    DROP TABLE IF EXISTS "people";
    CREATE TABLE "people" (
      "__id" TEXT PRIMARY KEY,
      "id" TEXT NOT NULL,
      "name" TEXT,
      "age" NUMERIC,
      "active" BOOLEAN
    );
    INSERT INTO "people" ("__id", "id", "name", "age", "active") VALUES ('row-1', 'p1', 'Alice', 30, TRUE);
    INSERT INTO "people" ("__id", "id", "name", "age", "active") VALUES ('row-2', 'p2', 'O''Brien', NULL, FALSE);
    COMMIT;
  `;

  it('reads columns, types and constraints — and drops the synthetic __id', () => {
    const { tables, unsupported } = parseSqlScript(script);
    expect(unsupported).toEqual([]);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.name).toBe('people');
    expect(tables[0]!.columns).toEqual([
      { field: 'id', label: 'id', type: 'string', notnull: true },
      { field: 'name', label: 'name', type: 'string' },
      { field: 'age', label: 'age', type: 'number' },
      { field: 'active', label: 'active', type: 'boolean' },
    ]);
  });

  it('reads rows, keeping NULLs and unescaping quotes', () => {
    const { tables } = parseSqlScript(script);
    expect(tables[0]!.rows).toEqual([
      { id: 'p1', name: 'Alice', age: 30, active: true },
      { id: 'p2', name: "O'Brien", age: null, active: false },
    ]);
  });

  it('accepts a multi-tuple INSERT and an unquoted table name', () => {
    const { tables } = parseSqlScript(`INSERT INTO people (id, name) VALUES ('p1', 'A'), ('p2', 'B');`);
    expect(tables[0]!.name).toBe('people');
    expect(tables[0]!.rows).toEqual([
      { id: 'p1', name: 'A' },
      { id: 'p2', name: 'B' },
    ]);
    // No CREATE TABLE, so the columns are inferred from the values.
    expect(tables[0]!.columns.map((c) => c.field)).toEqual(['id', 'name']);
  });
});

describe('SELECT → ProjectionSpec', () => {
  const tablesSql = `
    CREATE TABLE "people" ("id" TEXT, "name" TEXT, "deptId" TEXT);
    CREATE TABLE "dept" ("id" TEXT, "label" TEXT);
  `;

  it('reads a LEFT JOIN with its aliases, keys and column list', () => {
    const { projections, unsupported } = parseSqlScript(`
      ${tablesSql}
      -- projection: Staff by Dept
      SELECT
        "p"."name" AS "name",
        "d"."label" AS "dept"
      FROM "people" AS "p"
      LEFT JOIN "dept" AS "d" ON "d"."id" = "p"."deptId";
    `);
    expect(unsupported).toEqual([]);
    expect(projections).toHaveLength(1);
    expect(projections[0]!.name).toBe('Staff by Dept');
    expect(projections[0]!.spec).toEqual({
      version: 1,
      sources: [
        { alias: 'p', tableName: 'people' },
        { alias: 'd', tableName: 'dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
      ],
      columns: [
        { field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } },
        { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
      ],
    });
  });

  it('reads INNER JOIN, multi-key ON, filters, sort and a row cap', () => {
    const { projections, unsupported } = parseSqlScript(`
      ${tablesSql}
      SELECT "p"."name" AS "who", "d"."label" AS "dept"
      FROM "people" AS "p"
      INNER JOIN "dept" AS "d" ON "d"."id" = "p"."deptId" AND "d"."label" = "p"."name"
      WHERE LOWER("d"."label") LIKE '%sal%'
      ORDER BY "p"."name" DESC
      LIMIT 5;
    `);
    expect(unsupported).toEqual([]);
    const p = projections[0]!;
    expect(p.spec.sources[1]!.join).toEqual({
      type: 'inner',
      on: [
        { field: 'id', eqAlias: 'p', eqField: 'deptId' },
        { field: 'label', eqAlias: 'p', eqField: 'name' },
      ],
    });
    expect(p.spec.filters).toEqual({ dept: 'sal' });
    expect(p.spec.limit).toBe(5);
    // ORDER BY names the OUTPUT field, which is what Table.sortBy holds.
    expect(p.sortBy).toEqual([{ field: 'who', asc: false }]);
  });

  it('reads the other row-cap spellings', () => {
    const cap = (clause: string) => parseSqlScript(`${tablesSql} SELECT "p"."name" FROM "people" AS "p" ${clause};`).projections[0]?.spec.limit;
    expect(cap('LIMIT 7')).toBe(7);
    expect(cap('FETCH FIRST 7 ROWS ONLY')).toBe(7);
    expect(parseSqlScript(`${tablesSql} SELECT TOP 7 "p"."name" FROM "people" AS "p";`).projections[0]?.spec.limit).toBe(7);
  });

  it('resolves unqualified column and join references against the CREATE TABLEs', () => {
    const { projections, unsupported } = parseSqlScript(`
      ${tablesSql}
      SELECT name, label FROM people p JOIN dept d ON d.id = p.deptId;
    `);
    expect(unsupported).toEqual([]);
    expect(projections[0]!.spec.columns).toEqual([
      { field: 'name', from: { kind: 'source', alias: 'p', field: 'name' } },
      { field: 'label', from: { kind: 'source', alias: 'd', field: 'label' } },
    ]);
    // A bare JOIN is an inner join.
    expect(projections[0]!.spec.sources[1]!.join?.type).toBe('inner');
  });

  it('turns CREATE VIEW into a projection named after the view', () => {
    const { projections } = parseSqlScript(`${tablesSql} CREATE VIEW "staff" AS SELECT "p"."name" AS "name" FROM "people" AS "p";`);
    expect(projections[0]!.name).toBe('staff');
  });

  it('names an unlabelled SELECT after its base table', () => {
    const { projections } = parseSqlScript(`${tablesSql} SELECT "p"."name" AS "name" FROM "people" AS "p";`);
    expect(projections[0]!.name).toBe('people view');
  });

  it('supports the same table joined twice (a self-join)', () => {
    const { projections, unsupported } = parseSqlScript(`
      CREATE TABLE "til" ("id" TEXT, "title" TEXT);
      CREATE TABLE "similarities" ("a" TEXT, "b" TEXT);
      SELECT "x"."title" AS "from", "y"."title" AS "to"
      FROM "similarities" AS "s"
      LEFT JOIN "til" AS "x" ON "x"."id" = "s"."a"
      LEFT JOIN "til" AS "y" ON "y"."id" = "s"."b";
    `);
    expect(unsupported).toEqual([]);
    expect(projections[0]!.spec.sources.map((s) => `${s.tableName}:${s.alias}`)).toEqual(['similarities:s', 'til:x', 'til:y']);
  });

  it('brings a computed column back as an empty script rather than dropping it', () => {
    const { projections } = parseSqlScript(`${tablesSql} SELECT "p"."name" AS "name", NULL AS "greeting" FROM "people" AS "p";`);
    const computed = projections[0]!.spec.columns[1]!;
    expect(computed.field).toBe('greeting');
    expect(computed.from.kind).toBe('script');
    expect(computed.from.kind === 'script' && computed.from.script).toContain('function render');
  });
});

describe('what it refuses to guess at is reported, not dropped', () => {
  it('reports SELECT *, an unmodellable WHERE, a cross join and unknown statements', () => {
    const { unsupported } = parseSqlScript(`
      CREATE TABLE "t" ("a" TEXT);
      SELECT * FROM "t" AS "t1";
      SELECT "t1"."a" AS "a" FROM "t" AS "t1" WHERE "t1"."a" > 5;
      SELECT "t1"."a" AS "a" FROM "t" AS "t1" CROSS JOIN "t" AS "t2";
      GRANT SELECT ON "t" TO "bob";
    `);
    expect(unsupported).toEqual(
      expect.arrayContaining([expect.stringContaining('SELECT *'), expect.stringContaining('WHERE "t1"."a" > 5'), expect.stringContaining('CROSS JOIN'), expect.stringContaining('GRANT')]),
    );
  });

  it('does not split a filter value that contains the word AND', () => {
    const { projections, unsupported } = parseSqlScript(`
      CREATE TABLE "t" ("a" TEXT);
      SELECT "t1"."a" AS "a" FROM "t" AS "t1" WHERE LOWER("t1"."a") LIKE '%salt and pepper%';
    `);
    expect(unsupported).toEqual([]);
    expect(projections[0]!.spec.filters).toEqual({ a: 'salt and pepper' });
  });

  it('ignores transaction and DDL noise', () => {
    expect(parseSqlScript('BEGIN; COMMIT; DROP TABLE IF EXISTS "x"; PRAGMA foreign_keys=off;').unsupported).toEqual([]);
  });
});

describe('round trip: what sql-export writes, sql-parse reads back', () => {
  const people: Table = {
    id: 't1',
    workspaceId: 'ws',
    name: 'People',
    code: 'people',
    columns: [
      { field: 'id', label: 'Id', type: 'string', unique: true },
      { field: 'name', label: 'Name', type: 'string', notnull: true },
      { field: 'deptId', label: 'Dept Id', type: 'string' },
      { field: 'salary', label: 'Salary', type: 'number' },
    ],
    view: 'table',
    updatedAt: 0,
  };
  const rows = [
    { id: 'r1', tableId: 't1', data: { id: 'p1', name: 'Alice', deptId: 'd1', salary: 100 }, updatedAt: 0 },
    { id: 'r2', tableId: 't1', data: { id: 'p2', name: "O'Brien", deptId: null, salary: 90 }, updatedAt: 0 },
  ];

  it('a table survives its own export', () => {
    const { tables, unsupported } = parseSqlScript(serializeTableAsSql(people, rows));
    expect(unsupported).toEqual([]);
    expect(tables).toHaveLength(1);
    // The SQL identifier is the table's `code` — that is what the dump declares.
    expect(tables[0]!.name).toBe('people');
    expect(tables[0]!.columns.map((c) => c.field)).toEqual(['id', 'name', 'deptId', 'salary']);
    expect(tables[0]!.columns[0]!.unique).toBe(true);
    expect(tables[0]!.columns[1]!.notnull).toBe(true);
    expect(tables[0]!.rows).toEqual(rows.map((r) => r.data));
  });

  const spec: ProjectionSpec = {
    version: 1,
    sources: [
      { alias: 'p', tableName: 'People' },
      { alias: 'd', tableName: 'Dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
    ],
    columns: [
      { field: 'who', from: { kind: 'source', alias: 'p', field: 'name' } },
      { field: 'dept', from: { kind: 'source', alias: 'd', field: 'label' } },
    ],
    filters: { dept: 'sal' },
    limit: 25,
  };

  const projection: Table = {
    id: 't2',
    workspaceId: 'ws',
    name: 'Staff by Dept',
    code: 'staff-by-dept',
    columns: [
      { field: 'who', label: 'Who', type: 'string' },
      { field: 'dept', label: 'Dept', type: 'string' },
    ],
    view: 'table',
    updatedAt: 0,
    sortBy: [{ field: 'who', asc: false }],
    source: { type: 'projection', config: spec as unknown as Record<string, unknown> },
  };

  it('a projection survives its own export — every join key, filter and the cap', () => {
    const { projections, tables, unsupported } = parseSqlScript(serializeTableAsSql(projection, []));
    expect(unsupported).toEqual([]);
    expect(tables).toEqual([]); // a projection stores nothing
    expect(projections).toHaveLength(1);
    expect(projections[0]!.name).toBe('Staff by Dept');
    expect(projections[0]!.sortBy).toEqual([{ field: 'who', asc: false }]);
    // The source table NAMES come back as the SQL identifiers the dump used
    // (`People` → `people`), which is exactly what the CREATE TABLEs declare.
    expect(projections[0]!.spec).toEqual({
      ...spec,
      sources: [
        { alias: 'p', tableName: 'people' },
        { alias: 'd', tableName: 'dept', join: { type: 'left', on: [{ field: 'id', eqAlias: 'p', eqField: 'deptId' }] } },
      ],
    });
  });

  it('the exported SELECT names the very tables the exported CREATE TABLEs declare', () => {
    // The bug this pins: the projection SELECT used the table NAME ("People")
    // while renderTable declared the table's CODE ("people"), so the exported
    // query could not run against the exported dump.
    const script = `${serializeTableAsSql(people, rows)}\n${serializeTableAsSql(projection, [])}`;
    const { tables, projections } = parseSqlScript(script);
    const declared = new Set(tables.map((t) => t.name));
    expect(declared.has(projections[0]!.spec.sources[0]!.tableName)).toBe(true);
  });

  it('a whole workspace survives its own dump — tables, then the projections over them', async () => {
    // The case a user actually hits: Export SQL → Import that file. The dump
    // must be self-consistent, so every source a projection names has to be a
    // table the same file declared.
    const dept: Table = {
      id: 't3',
      workspaceId: 'ws',
      name: 'Dept',
      code: 'dept',
      columns: [
        { field: 'id', label: 'Id', type: 'string' },
        { field: 'label', label: 'Label', type: 'string' },
      ],
      view: 'table',
      updatedAt: 0,
    };
    const all = [people, dept, projection];
    const rowsByTable: Record<string, Row[]> = {
      t1: rows,
      t3: [{ id: 'd1', tableId: 't3', data: { id: 'd1', label: 'Sales' }, updatedAt: 0 }],
    };
    const api = {
      workspaceId: () => 'ws',
      store: {
        tables: { find: () => Promise.resolve(all) },
        rows: (id: string) => ({ find: () => Promise.resolve(rowsByTable[id] ?? []) }),
      },
    } as unknown as Parameters<typeof serializeWorkspaceAsSql>[0];

    const { tables: back, projections, unsupported } = parseSqlScript(await serializeWorkspaceAsSql(api));
    expect(unsupported).toEqual([]);
    // Only the two real tables get CREATE TABLE; the projection is a SELECT.
    expect(back.map((t) => t.name).sort()).toEqual(['dept', 'people']);
    expect(projections.map((p) => p.name)).toEqual(['Staff by Dept']);
    // Every source resolves to a table the same dump declared.
    const declared = new Set(back.map((t) => t.name));
    for (const s of projections[0]!.spec.sources) expect(declared.has(s.tableName)).toBe(true);
    // …and the label is not duplicated by the per-projection header.
    expect(projections[0]!.spec.limit).toBe(25);
    expect(projections[0]!.spec.filters).toEqual({ dept: 'sal' });
  });
});
