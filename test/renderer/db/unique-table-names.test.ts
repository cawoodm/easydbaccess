import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataCollection } from '../../../packages/shared/src/plugin-api.js';
import type { Table } from '../../../packages/shared/src/types.js';
import { withUniqueTableNames } from '../../../packages/renderer/src/db/unique-table-names.js';

/**
 * Scenario for every case below: a workspace that already holds one table, and
 * some other writer (a dump restore, a CSV import, a sync pull) trying to write
 * a table under a name that is taken. Two tables of the same name make every
 * projection and view instance that names it ambiguous, so the store renames
 * rather than store the duplicate.
 */

/** A `DataCollection<Table>` over a plain array — enough for the guard. */
function fakeTables(seed: Table[] = []) {
  const docs = [...seed];
  const coll: DataCollection<Table> = {
    find: async (query) => {
      if (!query) return [...docs];
      const entries = Object.entries(query as Record<string, unknown>);
      return docs.filter((d) => entries.every(([k, v]) => (d as unknown as Record<string, unknown>)[k] === v));
    },
    findOne: async (id) => docs.find((d) => d.id === id) ?? null,
    insert: async (doc) => {
      docs.push(doc);
      return doc;
    },
    bulkInsert: async (batch) => {
      docs.push(...batch);
      return batch;
    },
    upsert: async (doc) => {
      const i = docs.findIndex((d) => d.id === doc.id);
      if (i >= 0) docs[i] = doc;
      else docs.push(doc);
      return doc;
    },
    patch: async (id, patch) => {
      const i = docs.findIndex((d) => d.id === id);
      if (i < 0) throw new Error(`patch: no doc with id=${id}`);
      docs[i] = { ...docs[i]!, ...patch };
      return docs[i]!;
    },
    remove: async (id) => {
      const i = docs.findIndex((d) => d.id === id);
      if (i >= 0) docs.splice(i, 1);
    },
    bulkRemove: async (ids) => {
      for (const id of ids) await coll.remove(id);
    },
    subscribe: () => () => undefined,
  };
  return { coll, docs };
}

function table(id: string, name: string, workspaceId = 'ws'): Table {
  return { id, workspaceId, name, code: name, columns: [], view: 'table', updatedAt: 1 };
}

beforeEach(() => {
  // The guard warns on every rename; the console noise is not the subject here.
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('withUniqueTableNames — insert', () => {
  it('leaves a free name alone', async () => {
    const { coll } = fakeTables([table('a', 'places')]);
    const stored = await withUniqueTableNames(coll).insert(table('b', 'people'));
    expect(stored.name).toBe('people');
  });

  it('uniques a taken name and returns what it stored', async () => {
    const { coll, docs } = fakeTables([table('a', 'places')]);
    const stored = await withUniqueTableNames(coll).insert(table('b', 'places'));
    expect(stored.name).toBe('places-2');
    expect(docs.map((d) => d.name)).toEqual(['places', 'places-2']);
  });

  it('re-derives `code` so it still matches the stored name', async () => {
    const { coll } = fakeTables([table('a', 'My Places')]);
    const stored = await withUniqueTableNames(coll).insert(table('b', 'My Places'));
    expect(stored.name).toBe('My Places-2');
    expect(stored.code).toBe('my-places-2');
  });

  it('compares case-insensitively', async () => {
    const { coll } = fakeTables([table('a', 'Places')]);
    const stored = await withUniqueTableNames(coll).insert(table('b', 'places'));
    expect(stored.name).toBe('places-2');
  });

  it('ignores tables of another workspace', async () => {
    const { coll } = fakeTables([table('a', 'places', 'other')]);
    const stored = await withUniqueTableNames(coll).insert(table('b', 'places', 'ws'));
    expect(stored.name).toBe('places');
  });

  it('counts up past names already uniqued', async () => {
    const { coll } = fakeTables([table('a', 'places'), table('b', 'places-2')]);
    const stored = await withUniqueTableNames(coll).insert(table('c', 'places'));
    expect(stored.name).toBe('places-3');
  });
});

describe('withUniqueTableNames — bulkInsert', () => {
  it('resolves collisions inside the batch, not only against the store', async () => {
    const { coll } = fakeTables([table('a', 'places')]);
    const stored = await withUniqueTableNames(coll).bulkInsert([table('b', 'places'), table('c', 'places'), table('d', 'people')]);
    expect(stored.map((t) => t.name)).toEqual(['places-2', 'places-3', 'people']);
  });

  it('passes an empty batch straight through', async () => {
    const { coll } = fakeTables();
    expect(await withUniqueTableNames(coll).bulkInsert([])).toEqual([]);
  });
});

describe('withUniqueTableNames — upsert', () => {
  it('does not rename a table over its own name', async () => {
    const { coll } = fakeTables([table('a', 'places')]);
    const stored = await withUniqueTableNames(coll).upsert({
      ...table('a', 'places'),
      updatedAt: 2,
    });
    expect(stored.name).toBe('places');
    expect(stored.updatedAt).toBe(2);
  });

  it('uniques when another table holds the name', async () => {
    const { coll } = fakeTables([table('a', 'places'), table('b', 'people')]);
    const stored = await withUniqueTableNames(coll).upsert(table('b', 'places'));
    expect(stored.name).toBe('places-2');
  });
});

describe('withUniqueTableNames — patch', () => {
  it('passes a patch that does not touch the name through untouched', async () => {
    const { coll } = fakeTables([table('a', 'places')]);
    const spy = vi.spyOn(coll, 'patch');
    await withUniqueTableNames(coll).patch('a', { updatedAt: 9 });
    expect(spy).toHaveBeenCalledWith('a', { updatedAt: 9 });
  });

  it('keeps a rename that only re-writes the name the table already has', async () => {
    const { coll } = fakeTables([table('a', 'places')]);
    const stored = await withUniqueTableNames(coll).patch('a', { name: 'places' });
    expect(stored.name).toBe('places');
  });

  it('uniques a rename onto a taken name', async () => {
    const { coll } = fakeTables([table('a', 'places'), table('b', 'people')]);
    const stored = await withUniqueTableNames(coll).patch('b', { name: 'places' });
    expect(stored.name).toBe('places-2');
    expect(stored.code).toBe('places-2');
  });

  it('still reports a patch to a table that is gone', async () => {
    const { coll } = fakeTables();
    await expect(withUniqueTableNames(coll).patch('nope', { name: 'x' })).rejects.toThrow(/no doc with id=nope/);
  });
});
