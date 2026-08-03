import { describe, expect, it } from 'vitest';
import type { HostApi, ProjectionSpec, Table } from '@easydb/shared';
import { parseViewList } from '../../../packages/renderer/src/plugins/datasette-client.js';
import { createProjectionsForViews, runViewImport, viewTableUrl } from '../../../packages/renderer/src/plugins/datasette-views.js';

describe('parseViewList', () => {
  it('reads the string array Datasette returns', () => {
    expect(parseViewList({ tables: [], views: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('tolerates objects, and skips hidden ones', () => {
    expect(parseViewList({ views: [{ name: 'a' }, { name: 'h', hidden: true }] })).toEqual(['a']);
  });

  it('is empty for a payload with no views at all', () => {
    expect(parseViewList({ tables: ['t'] })).toEqual([]);
    expect(parseViewList(null)).toEqual([]);
    expect(parseViewList('nonsense')).toEqual([]);
  });
});

/** A store double: records inserts, answers `tables.find()` from what exists. */
function fakeApi(tables: Table[]) {
  const inserted: Table[] = [];
  const toasts: string[] = [];
  const api = {
    workspaceId: () => 'ws',
    ui: { dialogs: { toast: (m: string) => toasts.push(m) } },
    store: {
      tables: {
        find: () => Promise.resolve([...tables, ...inserted]),
        insert: (t: Table) => {
          inserted.push(t);
          return Promise.resolve(t);
        },
      },
    },
  } as unknown as HostApi;
  return { api, inserted, toasts };
}

const table = (name: string, fields: string[]): Table => ({
  id: `id-${name}`,
  workspaceId: 'ws',
  name,
  code: name,
  columns: fields.map((field) => ({ field, label: field.toUpperCase(), type: 'string' as const })),
  view: 'table',
  updatedAt: 0,
});

const specOf = (t: Table) => t.source?.config as unknown as ProjectionSpec;

describe('createProjectionsForViews', () => {
  // Datasette imports tables as `db/table`, but a view's SQL names them bare.
  const tables = [table('mydb/articles', ['id', 'title', 'author_id']), table('mydb/authors', ['id', 'name'])];
  const view = (name: string, sql: string) => ({ db: 'mydb', name, sql });

  it('turns a view into a projection over the imported tables', async () => {
    const { api, inserted } = fakeApi(tables);
    const res = await createProjectionsForViews(api, 'ws', [
      view('article_authors', 'CREATE VIEW article_authors AS SELECT a.title AS title, u.name AS author FROM articles a LEFT JOIN authors u ON u.id = a.author_id'),
    ]);

    expect(res.skipped).toEqual([]);
    expect(res.created).toEqual(['mydb/article_authors']);
    expect(inserted).toHaveLength(1);

    const spec = specOf(inserted[0]!);
    // Bound to the names the tables actually landed under, not the bare ones
    // the SQL used.
    expect(spec.sources.map((s) => s.tableName)).toEqual(['mydb/articles', 'mydb/authors']);
    expect(spec.sources[1]!.join).toEqual({ type: 'left', on: [{ field: 'id', eqAlias: 'a', eqField: 'author_id' }] });
    expect(spec.columns.map((c) => c.field)).toEqual(['title', 'author']);
  });

  it('inherits the source columns settings, so the projection looks like its sources', async () => {
    const { api, inserted } = fakeApi(tables);
    await createProjectionsForViews(api, 'ws', [view('v', 'CREATE VIEW v AS SELECT a.title AS title FROM articles a')]);
    expect(inserted[0]!.columns[0]).toMatchObject({ field: 'title', label: 'TITLE' });
  });

  it('reports a view whose source tables are not in the workspace, and creates nothing', async () => {
    const { api, inserted } = fakeApi([]);
    const res = await createProjectionsForViews(api, 'ws', [view('v', 'CREATE VIEW v AS SELECT a.title AS title FROM articles a')]);
    expect(inserted).toEqual([]);
    expect(res.created).toEqual([]);
    expect(res.skipped[0]?.reason).toContain('not in this workspace');
  });

  it('reports a view the parser cannot model instead of importing half of it', async () => {
    const { api, inserted } = fakeApi(tables);
    const res = await createProjectionsForViews(api, 'ws', [view('v', 'CREATE VIEW v AS SELECT * FROM articles a')]);
    expect(inserted).toHaveLength(1); // the shape is known; the column list is not
    expect(res.skipped[0]?.reason).toContain('SELECT *');
  });

  it('lets a later view read an earlier one', async () => {
    const { api, inserted } = fakeApi(tables);
    const res = await createProjectionsForViews(api, 'ws', [
      view('titles', 'CREATE VIEW titles AS SELECT a.title AS title FROM articles a'),
      view('shouty', 'CREATE VIEW shouty AS SELECT t.title AS title FROM titles t'),
    ]);
    expect(res.created).toEqual(['mydb/titles', 'mydb/shouty']);
    expect(specOf(inserted[1]!).sources[0]!.tableName).toBe('mydb/titles');
  });

  it('uniques a projection name that collides with an existing table', async () => {
    const { api, inserted } = fakeApi([...tables, table('mydb/v', ['x'])]);
    const res = await createProjectionsForViews(api, 'ws', [view('v', 'CREATE VIEW v AS SELECT a.title AS title FROM articles a')]);
    expect(res.created).toEqual(['mydb/v-2']);
    expect(inserted[0]!.name).toBe('mydb/v-2');
  });

  it('does nothing at all for a database with no views', async () => {
    const { api, inserted } = fakeApi(tables);
    const res = await createProjectionsForViews(api, 'ws', []);
    expect(res).toEqual({ created: [], skipped: [], found: 0 });
    expect(inserted).toEqual([]);
  });
});

describe('importing views as snapshot TABLES instead of projections', () => {
  const views = [
    { db: 'mydb', name: 'article_authors', sql: 'CREATE VIEW article_authors AS SELECT a.x AS x FROM articles a' },
    { db: 'my db', name: 'odd name', sql: 'CREATE VIEW "odd name" AS SELECT a.x AS x FROM articles a' },
  ];

  it('points the table importer at the view’s own endpoint', () => {
    // Datasette serves a view exactly like a table, so the ordinary importer
    // handles it — paging, progress and all.
    expect(viewTableUrl('https://x.datasette.io', views[0]!)).toBe('https://x.datasette.io/mydb/article_authors');
  });

  it('encodes a database or view name with spaces', () => {
    expect(viewTableUrl('https://x.datasette.io', views[1]!)).toBe('https://x.datasette.io/my%20db/odd%20name');
  });

  it('runs the table importer, and creates no projections, in table mode', async () => {
    const { api, inserted } = fakeApi([]);
    const urls: string[][] = [];
    await runViewImport(api, 'https://x.datasette.io', views, 'table', async (u) => {
      urls.push(u);
    });
    expect(urls).toEqual([['https://x.datasette.io/mydb/article_authors', 'https://x.datasette.io/my%20db/odd%20name']]);
    expect(inserted).toEqual([]);
  });

  it('creates projections, and calls no table importer, in projection mode', async () => {
    const { api, inserted } = fakeApi([table('mydb/articles', ['x'])]);
    let calls = 0;
    await runViewImport(api, 'https://x.datasette.io', [views[0]!], 'projection', async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
    expect(inserted.map((t) => t.name)).toEqual(['mydb/article_authors']);
    expect(inserted[0]!.source?.type).toBe('projection');
  });
});
