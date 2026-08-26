import { describe, expect, it } from 'vitest';
import { seedDefaults } from '../../../packages/renderer/src/plugins/views-seed.js';
import type { HostApi } from '../../../packages/shared/src/plugin-api.js';

/**
 * Seeding the built-in view templates must be READ-ONLY once it has nothing to do.
 *
 * It runs on every load. Every write the store takes is broadcast, and the file
 * layer turns that broadcast into "unsaved changes" — so four no-op upserts, one
 * per built-in template, were enough to bring a freshly saved workspace back from
 * a reload with a red dot on Save. Nothing else in a plain boot writes at all,
 * which is what made these four the whole bug.
 */

interface Doc {
  [k: string]: unknown;
}

/** The two collections `views.ts` touches, plus a tally of every write. */
function fakeApi(): { api: HostApi; writes: string[]; templates: Doc[]; settings: Map<string, unknown> } {
  const writes: string[] = [];
  const templates: Doc[] = [];
  const settings = new Map<string, unknown>();

  const api = {
    workspaceId: () => 'ws1',
    store: {
      viewTemplates: {
        find: () => Promise.resolve(templates),
        insert: (doc: Doc) => {
          writes.push(`viewTemplates.insert:${String(doc['name'])}`);
          templates.push(doc);
          return Promise.resolve(doc);
        },
        patch: (id: string, fields: Doc) => {
          writes.push(`viewTemplates.patch:${id}`);
          const t = templates.find((x) => x['id'] === id);
          if (t) Object.assign(t, fields);
          return Promise.resolve(t);
        },
      },
      settings: {
        findOne: (name: string) => Promise.resolve(settings.has(name) ? { name, value: settings.get(name) } : null),
        upsert: (doc: Doc) => {
          writes.push(`settings.upsert:${String(doc['name'])}`);
          settings.set(String(doc['name']), doc['value']);
          return Promise.resolve(doc);
        },
      },
    },
  } as unknown as HostApi;

  return { api, writes, templates, settings };
}

describe('the built-in view templates', () => {
  it('are seeded on a fresh workspace', async () => {
    const { api, templates, settings } = fakeApi();
    await seedDefaults(api);
    expect(templates).toHaveLength(4);
    expect(templates.map((t) => t['name'])).toEqual(['RSS Feed', 'Todo List', 'Gallery', 'Contact Cards']);
    // Both marks per template: seeded, and the signature it was seeded from.
    expect(settings.size).toBe(8);
  });

  it('writes NOTHING on a second load, which is what a reload is', async () => {
    const { api, writes } = fakeApi();
    await seedDefaults(api);
    writes.length = 0;

    await seedDefaults(api);

    expect(writes).toEqual([]);
  });

  it('writes nothing on the tenth load either', async () => {
    const { api, writes } = fakeApi();
    for (let i = 0; i < 10; i++) await seedDefaults(api);
    const after = writes.filter((w) => !w.startsWith('viewTemplates.insert')).length;
    // The 8 marks from the first load, and not one write since.
    expect(after).toBe(8);
  });

  it('still updates a template whose shipped HTML has changed', async () => {
    const { api, writes, templates, settings } = fakeApi();
    await seedDefaults(api);
    writes.length = 0;

    // What an app release looks like from the workspace's side: the stored
    // signature no longer matches the shipped one.
    settings.set('views:sig:rss:ws1', 'stale');
    await seedDefaults(api);

    expect(writes).toContain('settings.upsert:views:sig:rss:ws1');
    expect(writes.some((w) => w.startsWith('viewTemplates.patch:'))).toBe(true);
    // And only that one — the other three are untouched.
    expect(writes.filter((w) => w.startsWith('viewTemplates.patch:'))).toHaveLength(1);
    expect(templates).toHaveLength(4);
  });

  it('leaves a built-in the user deleted deleted, and says nothing about it', async () => {
    const { api, writes, templates } = fakeApi();
    await seedDefaults(api);
    const i = templates.findIndex((t) => t['name'] === 'Gallery');
    templates.splice(i, 1);
    writes.length = 0;

    await seedDefaults(api);

    // The seeded mark is what remembers we provisioned it once. Nothing is
    // re-seeded, and nothing is written to say so.
    expect(templates.some((t) => t['name'] === 'Gallery')).toBe(false);
    expect(writes).toEqual([]);
  });

  it('does nothing at all without a workspace', async () => {
    const { api, writes } = fakeApi();
    (api as unknown as { workspaceId: () => string }).workspaceId = () => '';
    await seedDefaults(api);
    expect(writes).toEqual([]);
  });
});
