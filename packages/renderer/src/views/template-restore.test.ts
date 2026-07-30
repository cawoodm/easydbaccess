import { describe, expect, it } from 'vitest';
import type { DataCollection, ViewTemplate } from '@easydb/shared';
import { restoreTemplates } from './template-restore.js';

/** The two collection methods `restoreTemplates` uses, over a plain array. */
function fakeColl(seed: ViewTemplate[]): DataCollection<ViewTemplate> & { all: ViewTemplate[] } {
  const all = [...seed];
  return {
    all,
    async find() {
      return [...all];
    },
    async upsert(doc: ViewTemplate) {
      const i = all.findIndex((t) => t.id === doc.id);
      if (i >= 0) all[i] = doc;
      else all.push(doc);
      return doc;
    },
  } as unknown as DataCollection<ViewTemplate> & { all: ViewTemplate[] };
}

function tpl(over: Partial<ViewTemplate>): ViewTemplate {
  return {
    id: 'id',
    workspaceId: 'ws',
    name: 'Gallery',
    headerHtml: '<div>',
    rowHtml: '<span>',
    footerHtml: '</div>',
    updatedAt: 1,
    ...over,
  };
}

describe('restoreTemplates', () => {
  it('overwrites a same-named template that carries a different id', async () => {
    // views.ts seeds built-ins with a fresh uuid per workspace, so a dump from
    // another device names the same template under a foreign id.
    const coll = fakeColl([tpl({ id: 'local-1', name: 'Gallery', builtin: true, rowHtml: 'old' })]);

    const remap = await restoreTemplates(coll, 'ws', [
      tpl({ id: 'foreign-1', name: 'Gallery', builtin: true, rowHtml: 'new' }),
    ]);

    expect(coll.all).toHaveLength(1);
    expect(coll.all[0]!.id).toBe('local-1');
    expect(coll.all[0]!.rowHtml).toBe('new');
    expect(remap.get('foreign-1')).toBe('local-1');
  });

  it('inserts a template the workspace does not have', async () => {
    const coll = fakeColl([tpl({ id: 'local-1', name: 'Gallery' })]);

    const remap = await restoreTemplates(coll, 'ws', [tpl({ id: 'foreign-2', name: 'Cards' })]);

    expect(coll.all.map((t) => t.name).sort()).toEqual(['Cards', 'Gallery']);
    expect(remap.size).toBe(0);
  });

  it('keeps the local built-in flag rather than the one in the dump', async () => {
    // A user template must not become a built-in on import — views.ts would
    // then reconcile it against the shipped HTML and overwrite the user's work.
    const coll = fakeColl([tpl({ id: 'local-1', name: 'Gallery' })]);

    await restoreTemplates(coll, 'ws', [tpl({ id: 'foreign-1', builtin: true })]);

    expect(coll.all[0]!.builtin).toBeUndefined();
  });

  it('re-homes an imported template into the importing workspace', async () => {
    const coll = fakeColl([]);

    await restoreTemplates(coll, 'ws-b', [tpl({ id: 'x', workspaceId: 'ws-a' })]);

    expect(coll.all[0]!.workspaceId).toBe('ws-b');
  });

  it('collapses two incoming templates that share a name onto one record', async () => {
    const coll = fakeColl([]);

    const remap = await restoreTemplates(coll, 'ws', [
      tpl({ id: 'a', name: 'Cards', rowHtml: 'first' }),
      tpl({ id: 'b', name: 'Cards', rowHtml: 'second' }),
    ]);

    expect(coll.all).toHaveLength(1);
    expect(coll.all[0]!.rowHtml).toBe('second');
    expect(remap.get('b')).toBe('a');
  });

  it('ignores templates of another workspace when matching by name', async () => {
    const coll = fakeColl([tpl({ id: 'other-ws', name: 'Gallery', workspaceId: 'ws-b' })]);

    const remap = await restoreTemplates(coll, 'ws-a', [tpl({ id: 'foreign', name: 'Gallery' })]);

    expect(coll.all).toHaveLength(2);
    expect(remap.size).toBe(0);
  });
});
