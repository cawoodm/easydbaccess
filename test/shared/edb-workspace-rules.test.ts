import { beforeEach, describe, expect, it } from 'vitest';
import { EdbStore } from '../../packages/shared/src/edb-store.js';
import { nodeSqliteDriver } from './node-sqlite-driver.js';

/**
 * The workspace invariant, kept by the STORE.
 *
 * It used to live in app code alone — `mayCreateWorkspaceIn` at the one line that
 * creates a workspace at boot, `one-per-file.ts` at every save, `file-identity.ts`
 * at every sync. Three checks, and the gaps between them were real: New workspace
 * ▸ Simple wrote a second workspace into an open `.edb` through none of them, and
 * a file that arrived already holding two was nobody's business at all.
 *
 * So the rules are tested here against the thing that now enforces them.
 */

const open = (fileName?: string) => new EdbStore(nodeSqliteDriver(), fileName === undefined ? {} : { fileName });
const ws = (id: string, extra: Record<string, unknown> = {}) => ({ id, createdAt: 1, pluginUrls: [], ...extra });

describe('a workspace id must be canonical', () => {
  let store: EdbStore;
  beforeEach(() => {
    store = open();
  });

  it.each(['My Data', 'Sales', 'q3 2026', 'trailing-'])('refuses %o, which no file name could round-trip', (id) => {
    expect(() => store.insert('workspaces', ws(id))).toThrow(/not a usable workspace id/);
  });

  it('accepts one that is already its own slug', () => {
    expect(() => store.insert('workspaces', ws('my-data'))).not.toThrow();
  });

  it('refuses it on an upsert too, not only on the first write', () => {
    expect(() => store.upsert('workspaces', ws('My Data'))).toThrow(/not a usable workspace id/);
  });

  it('says what is wrong, naming the id and the reason', () => {
    // The message is read by whoever is holding the broken file, so it has to say
    // more than "invalid".
    expect(() => store.insert('workspaces', ws('My Data'))).toThrow(/"My Data".*file name/s);
  });
});

describe('a .edb holds the one workspace its name says', () => {
  it('takes the workspace the file is named after', () => {
    const store = open('powerplants.edb');
    expect(() => store.insert('workspaces', ws('powerplants'))).not.toThrow();
  });

  it('refuses a second workspace beside it — the reported bug', () => {
    // `powerplants.edb` held `powerplants` AND `simon`, so the selector showed two
    // rows reading the same thing with the same file in both tooltips.
    const store = open('powerplants.edb');
    store.insert('workspaces', ws('powerplants'));
    expect(() => store.insert('workspaces', ws('simon'))).toThrow(/a .edb holds the one workspace its name says/);
  });

  it('refuses the passenger even when the file is still empty', () => {
    // The rule is about the FILE's name, not about what it happens to hold yet.
    const store = open('powerplants.edb');
    expect(() => store.insert('workspaces', ws('simon'))).toThrow(/holds the workspace "powerplants"/);
  });

  it('reads the rule through a full path, as the desktop passes one', () => {
    const store = open('C:\\Users\\marc\\Documents\\edb\\sales.edb');
    expect(() => store.insert('workspaces', ws('sales'))).not.toThrow();
    expect(() => store.insert('workspaces', ws('other'))).toThrow();
  });

  it('lets the project index hold any number, which is what it is for', () => {
    const store = open('index.edp');
    store.insert('workspaces', ws('alpha'));
    store.insert('workspaces', ws('beta'));
    expect((store.find('workspaces') as Array<{ id: string }>).map((w) => w.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('holds an unnamed database to nothing — a scratch worker opens those', () => {
    const store = open();
    store.insert('workspaces', ws('alpha'));
    expect(() => store.insert('workspaces', ws('beta'))).not.toThrow();
  });

  it('guards a clone as well, which used to write straight to storage', () => {
    const store = open('sales.edb');
    store.insert('workspaces', ws('sales'));
    expect(() => store.cloneWorkspace({ from: 'sales', to: 'sales-copy', mode: 'empty' })).toThrow(/a .edb holds the one workspace/);
  });
});

describe('the id is unique, and the store is what says so', () => {
  it('refuses a second workspace under an id already taken', () => {
    const store = open('index.edp');
    store.insert('workspaces', ws('sales'));
    expect(() => store.insert('workspaces', ws('sales'))).toThrow(/already exists/);
  });

  it('an upsert replaces rather than duplicating', () => {
    const store = open('index.edp');
    store.insert('workspaces', ws('sales', { title: 'First' }));
    store.upsert('workspaces', ws('sales', { title: 'Second' }));
    const all = store.find('workspaces') as Array<{ id: string; title?: string }>;
    expect(all).toHaveLength(1);
    expect(all[0]?.title).toBe('Second');
  });
});

describe('a clone is a creation, and obeys the same rules', () => {
  it('refuses to clone onto an id already taken, rather than replacing it', () => {
    // It wrote through `putRaw` — an INSERT OR REPLACE with no existence check —
    // so New workspace > Simple under a name that slugified onto a workspace
    // already here REPLACED that workspace's record and merged the clone's tables
    // into it. The one creation path where the id was not actually unique.
    const store = open('index.edp');
    store.insert('workspaces', ws('sales', { title: 'The real one' }));
    store.insert('workspaces', ws('scratch'));
    expect(() => store.cloneWorkspace({ from: 'scratch', to: 'sales', title: 'Clone', mode: 'empty' })).toThrow(/already exists/);
    expect(store.findOne('workspaces', 'sales')).toMatchObject({ title: 'The real one' });
  });

  it('carries the title onto the copy', () => {
    const store = open('index.edp');
    store.insert('workspaces', ws('sales'));
    store.cloneWorkspace({ from: 'sales', to: 'sales-2', title: 'Last quarter', mode: 'empty' });
    expect(store.findOne('workspaces', 'sales-2')).toMatchObject({ id: 'sales-2', title: 'Last quarter' });
  });

  it('leaves a copy with no title of its own untitled, rather than inventing one', () => {
    const store = open('index.edp');
    store.insert('workspaces', ws('sales', { title: 'Sales' }));
    store.cloneWorkspace({ from: 'sales', to: 'sales-2', mode: 'empty' });
    expect(store.findOne('workspaces', 'sales-2')).not.toHaveProperty('title');
  });
});

describe('a workspace written by an older version', () => {
  /** What v0.0.503 and earlier wrote: an id, a `name`, and maybe a title. */
  const legacy = (doc: Record<string, unknown>) => {
    const store = open('powerplants.edb');
    // Straight into the table, because the guarded write is what we are reading
    // AROUND — this is a file that already exists, not one being made now.
    store.runSql(`INSERT INTO _easydb (coll, key, workspaceId, doc) VALUES ('workspaces', 'powerplants', NULL, ?)`, { params: [JSON.stringify(doc)], write: true });
    return store;
  };

  it('is read with its name as the title, so the workspace keeps its label', () => {
    const store = legacy({ id: 'powerplants', name: 'PowerPlants', createdAt: 1, pluginUrls: [] });
    expect(store.findOne('workspaces', 'powerplants')).toMatchObject({ id: 'powerplants', title: 'PowerPlants' });
  });

  it('keeps a real title where the doc carried both', () => {
    const store = legacy({ id: 'powerplants', name: 'simon', title: 'Power Plants', createdAt: 1, pluginUrls: [] });
    expect(store.findOne('workspaces', 'powerplants')).toMatchObject({ title: 'Power Plants' });
  });

  it('never hands the name back, so nothing downstream can read it by accident', () => {
    const store = legacy({ id: 'powerplants', name: 'PowerPlants', createdAt: 1, pluginUrls: [] });
    expect(store.findOne('workspaces', 'powerplants')).not.toHaveProperty('name');
    expect((store.find('workspaces') as Array<Record<string, unknown>>)[0]).not.toHaveProperty('name');
  });

  it('is NOT rewritten by being read — a boot that writes marks the workspace unsaved', () => {
    const store = legacy({ id: 'powerplants', name: 'PowerPlants', createdAt: 1, pluginUrls: [] });
    store.find('workspaces');
    store.findOne('workspaces', 'powerplants');
    const stored = store.runSql(`SELECT doc FROM _easydb WHERE coll = 'workspaces'`, {});
    expect(String(stored.rows[0]?.[0])).toContain('"name":"PowerPlants"');
  });

  it('loses its name on the first patch, so a cleared title stays cleared', () => {
    // `patch` merged onto the RAW doc, so the legacy `name` rode along for ever.
    // Clearing the title then looked as if it had not taken: the cleared key fell
    // back to `name` on the way out and the old label came straight back.
    const store = legacy({ id: 'powerplants', name: 'PowerPlants', title: 'Power Plants', createdAt: 1, pluginUrls: [] });
    store.patch('workspaces', 'powerplants', { title: undefined });
    expect(store.findOne('workspaces', 'powerplants')).not.toHaveProperty('title');
    const stored = store.runSql(`SELECT doc FROM _easydb WHERE coll = 'workspaces'`, {});
    expect(String(stored.rows[0]?.[0])).not.toContain('"name"');
  });

  it('keeps every other field through that patch', () => {
    const store = legacy({ id: 'powerplants', name: 'PowerPlants', createdAt: 7, pluginUrls: ['https://example.test/p.js'] });
    store.patch('workspaces', 'powerplants', { title: 'Renamed' });
    expect(store.findOne('workspaces', 'powerplants')).toMatchObject({ id: 'powerplants', title: 'Renamed', createdAt: 7, pluginUrls: ['https://example.test/p.js'] });
  });

  it('still opens a file the rule would refuse to write today', () => {
    // A `.edb` holding a non-canonical id is a file this app can still show. It is
    // reported (`file-identity.ts`), never refused, or the data would be stranded.
    const store = open('my data.edb');
    store.runSql(`INSERT INTO _easydb (coll, key, workspaceId, doc) VALUES ('workspaces', 'My Data', NULL, ?)`, {
      params: [JSON.stringify({ id: 'My Data', name: 'My Data', createdAt: 1, pluginUrls: [] })],
      write: true,
    });
    expect(store.findOne('workspaces', 'My Data')).toMatchObject({ id: 'My Data', title: 'My Data' });
  });
});
