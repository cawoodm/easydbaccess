import { describe, expect, it } from 'vitest';
import type { EasyDb } from '../../../packages/renderer/src/db/dexie-db.js';
import { countWorkspaceContents, deleteWorkspace, describeWorkspaceContents } from '../../../packages/renderer/src/db/delete-workspace.js';

/**
 * Deleting a workspace, and the sentence that asks the user to allow it.
 *
 * Two things here are easy to get wrong and cost real time in the app:
 *
 * 1. The confirm dialog must not COUNT the rows. Counting a workspace that holds a
 *    609,283-row table costs 14 seconds in IndexedDB, and the dialog is what the
 *    user is waiting for. So `rows: -1` means "nobody paid for this number" and the
 *    sentence says "and all their rows" instead of guessing one.
 * 2. The delete must still report a real row total, and must get it from the rows it
 *    already read to delete them. A second pass would pay the 14 seconds after all.
 *
 * The store is a hand-written fake rather than Dexie on a fake IndexedDB: what is
 * under test is which queries this module ISSUES, so the calls are logged and
 * asserted. Dexie is a dependency of `dexie-db.ts`, not of these two functions.
 */

type Rec = Record<string, unknown>;

interface Seed {
  tables?: Rec[];
  rows?: Rec[];
  viewInstances?: Rec[];
  viewTemplates?: Rec[];
  settings?: Rec[];
  workspaces?: Rec[];
}

/** A fake `EasyDb` that answers the four calls this module makes, and logs them. */
function makeDb(seed: Seed) {
  const log: string[] = [];
  const bag = (name: string, items: Rec[], keyField: string) => ({
    items,
    where(field: string) {
      const pick = (vals: unknown[]) => items.filter((i) => vals.includes(i[field]));
      const query = (vals: unknown[]) => ({
        toArray: async () => {
          log.push(`${name}.toArray`);
          return pick(vals);
        },
        count: async () => {
          log.push(`${name}.count`);
          return pick(vals).length;
        },
      });
      return { equals: (v: unknown) => query([v]), anyOf: (vs: unknown[]) => query(vs) };
    },
    bulkDelete: async (keys: unknown[]) => {
      log.push(`${name}.bulkDelete(${keys.length})`);
      for (const k of keys) {
        const at = items.findIndex((i) => i[keyField] === k);
        if (at >= 0) items.splice(at, 1);
      }
    },
    delete: async (key: unknown) => {
      log.push(`${name}.delete`);
      const at = items.findIndex((i) => i[keyField] === key);
      if (at >= 0) items.splice(at, 1);
    },
  });

  const bags = {
    tables: bag('tables', seed.tables ?? [], 'id'),
    rows: bag('rows', seed.rows ?? [], 'id'),
    viewInstances: bag('viewInstances', seed.viewInstances ?? [], 'id'),
    viewTemplates: bag('viewTemplates', seed.viewTemplates ?? [], 'id'),
    settings: bag('settings', seed.settings ?? [], 'key'),
    workspaces: bag('workspaces', seed.workspaces ?? [], 'id'),
  };
  return { db: bags as unknown as EasyDb, bags, log };
}

/** One workspace with two tables, three rows, a view, a template and two settings. */
function populated() {
  return makeDb({
    workspaces: [{ id: 'mine', name: 'Mine' }, { id: 'other', name: 'Other' }],
    tables: [
      { id: 't1', workspaceId: 'mine' },
      { id: 't2', workspaceId: 'mine' },
      { id: 't9', workspaceId: 'other' },
    ],
    rows: [
      { id: 'r1', tableId: 't1' },
      { id: 'r2', tableId: 't1' },
      { id: 'r3', tableId: 't2' },
      { id: 'r9', tableId: 't9' },
    ],
    viewInstances: [
      { id: 'v1', workspaceId: 'mine' },
      { id: 'v9', workspaceId: 'other' },
    ],
    viewTemplates: [{ id: 'tpl1', workspaceId: 'mine' }],
    settings: [
      { key: 'mine:a', workspaceId: 'mine' },
      { key: 'mine:b', workspaceId: 'mine' },
      { key: 'other:a', workspaceId: 'other' },
    ],
  });
}

describe('describeWorkspaceContents', () => {
  const contents = (over: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...over });
  function base() {
    return { tables: 1, rows: 1, views: 1, templates: 1, settings: 1 };
  }

  it('names every part, singular', () => {
    expect(describeWorkspaceContents(contents())).toBe('1 table, 1 row, 1 view, 1 setting');
  });

  it('pluralizes, including zero', () => {
    expect(describeWorkspaceContents(contents({ tables: 2, rows: 0, views: 3, settings: 0 }))).toBe('2 tables, 0 rows, 3 views, 0 settings');
  });

  it('groups a big row total', () => {
    // Built with `toLocaleString` so the expectation follows the machine's locale
    // rather than asserting one separator.
    expect(describeWorkspaceContents(contents({ rows: 609_283 }))).toContain(`${(609_283).toLocaleString()} rows`);
  });

  it('says "and all their rows" when the rows were not counted', () => {
    expect(describeWorkspaceContents(contents({ rows: -1 }))).toBe('1 table, 1 view, 1 setting and all their rows');
  });

  it('leaves the templates out — a template is workspace-global chrome, not content the user put there', () => {
    expect(describeWorkspaceContents(contents({ templates: 7 }))).not.toContain('7');
  });
});

describe('countWorkspaceContents', () => {
  it('does not touch the rows by default, and says so with -1', async () => {
    const { db, log } = populated();
    const counts = await countWorkspaceContents(db, 'mine');
    expect(counts.rows).toBe(-1);
    expect(log.filter((l) => l.startsWith('rows.'))).toEqual([]);
  });

  it('counts everything else, scoped to the one workspace', async () => {
    const { db } = populated();
    const counts = await countWorkspaceContents(db, 'mine');
    expect(counts).toMatchObject({ tables: 2, views: 1, templates: 1, settings: 2 });
  });

  it('counts the rows when asked', async () => {
    const { db, log } = populated();
    expect((await countWorkspaceContents(db, 'mine', { countRows: true })).rows).toBe(3);
    expect(log).toContain('rows.count');
  });

  it('skips the row query for a workspace with no tables', async () => {
    const { db, log } = makeDb({ workspaces: [{ id: 'empty' }] });
    expect((await countWorkspaceContents(db, 'empty', { countRows: true })).rows).toBe(0);
    expect(log.filter((l) => l.startsWith('rows.'))).toEqual([]);
  });
});

describe('deleteWorkspace', () => {
  it('takes the tables, rows, views, templates and settings of that workspace', async () => {
    const { db, bags } = populated();
    await deleteWorkspace(db, 'mine');
    expect(bags.tables.items.map((t) => t.id)).toEqual(['t9']);
    expect(bags.rows.items.map((r) => r.id)).toEqual(['r9']);
    expect(bags.viewInstances.items.map((v) => v.id)).toEqual(['v9']);
    expect(bags.viewTemplates.items).toEqual([]);
    expect(bags.settings.items.map((s) => s.key)).toEqual(['other:a']);
    expect(bags.workspaces.items.map((w) => w.id)).toEqual(['other']);
  });

  it('reports the row total from the rows it read, without a count query', async () => {
    const { db, log } = populated();
    const counts = await deleteWorkspace(db, 'mine');
    expect(counts.rows).toBe(3);
    expect(log).not.toContain('rows.count');
  });

  it('reports zero rows for an empty workspace', async () => {
    const { db } = makeDb({ workspaces: [{ id: 'empty' }] });
    expect((await deleteWorkspace(db, 'empty')).rows).toBe(0);
  });

  it('removes the workspace record last, so an interrupted delete leaves something to retry', async () => {
    const { db, log } = populated();
    await deleteWorkspace(db, 'mine');
    expect(log[log.length - 1]).toBe('workspaces.delete');
  });

  it('skips a settings record with no key', async () => {
    // `key` is optional on the type. A stored row always has one, so a record
    // without it must not become `bulkDelete(undefined)`.
    const { db, bags } = makeDb({
      workspaces: [{ id: 'mine' }],
      settings: [{ workspaceId: 'mine' }, { key: 'mine:a', workspaceId: 'mine' }],
    });
    await deleteWorkspace(db, 'mine');
    expect(bags.settings.items).toEqual([{ workspaceId: 'mine' }]);
  });
});
