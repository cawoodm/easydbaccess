import { describe, expect, it } from 'vitest';
import type { Row, Table, ViewInstance, ViewTemplate, Workspace } from '../../../../packages/shared/src/types.js';
import type { LegacyWorkspaceMeta } from '../../../../packages/renderer/src/db/legacy-idb/read.js';
import { applyRemap, buildRemap, identityRemap, legacyTableIds, remapRow } from '../../../../packages/renderer/src/db/legacy-idb/remap.js';

const workspace: Workspace = { id: 'demo', name: 'demo', createdAt: 0, pluginUrls: [], title: 'My Demo' };

const people: Table = {
  id: 't-people',
  workspaceId: 'demo',
  name: 'People',
  code: 'people',
  columns: [{ field: 'name', label: 'Name', type: 'string' }],
  view: 'table',
  updatedAt: 0,
};

const pets: Table = { ...people, id: 't-pets', name: 'Pets', code: 'pets' };

const template: ViewTemplate = {
  id: 'tpl-1',
  workspaceId: 'demo',
  name: 'Cards',
  headerHtml: '',
  rowHtml: '<b>$NAME</b>',
  footerHtml: '',
  updatedAt: 0,
};

const instance: ViewInstance = {
  id: 'vi-1',
  workspaceId: 'demo',
  tableId: 't-people',
  templateId: 'tpl-1',
  name: 'People cards',
  filters: {},
  visibleColumns: ['name'],
  mapping: { NAME: 'name' },
  open: true,
  updatedAt: 0,
};

const meta: LegacyWorkspaceMeta = {
  workspace,
  tables: [people, pets],
  settings: [{ name: 'gist-sync:token', value: 'abc' }],
  plugins: [{ url: 'https://example.test/p.js', enabled: true, lastFetched: 0 }],
  viewTemplates: [template],
  viewInstances: [instance],
};

/** Deterministic ids, so the assertions can name them. */
function counter(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

describe('identityRemap', () => {
  it('changes nothing, which is what a fresh copy and an overwrite both want', () => {
    const out = applyRemap(meta, identityRemap('demo'));
    expect(out.workspace).toEqual(workspace);
    expect(out.tables).toEqual([people, pets]);
    expect(out.viewTemplates).toEqual([template]);
    expect(out.viewInstances).toEqual([instance]);
  });

  it('still re-homes documents when the workspace id itself is the target', () => {
    // An overwrite writes under the same id, so the workspaceId stamped on each
    // table has to keep matching it.
    const out = applyRemap(meta, identityRemap('demo'));
    expect(out.tables.every((t) => t.workspaceId === 'demo')).toBe(true);
  });
});

describe('buildRemap + applyRemap', () => {
  it('gives the workspace the target id and name, and leaves the title alone', () => {
    const out = applyRemap(meta, buildRemap(meta, 'demo-2', counter()));
    expect(out.workspace.id).toBe('demo-2');
    expect(out.workspace.name).toBe('demo-2');
    // The user's label for this data is still their label for the copy.
    expect(out.workspace.title).toBe('My Demo');
  });

  it('re-ids every table, because table ids are unique across ALL workspaces', () => {
    const remap = buildRemap(meta, 'demo-2', counter());
    const out = applyRemap(meta, remap);
    expect(out.tables.map((t) => t.id)).toEqual(['new-1', 'new-2']);
    expect(out.tables.every((t) => t.workspaceId === 'demo-2')).toBe(true);
    // The rest of the table is untouched — this is a re-id, not a rewrite.
    expect(out.tables[0]!.name).toBe('People');
    expect(out.tables[0]!.columns).toEqual(people.columns);
  });

  it('repoints a row at its table’s new id', () => {
    const remap = buildRemap(meta, 'demo-2', counter());
    const row: Row = { id: 'r1', tableId: 't-people', data: { name: 'Ada' }, updatedAt: 0 };
    expect(remapRow(row, remap).tableId).toBe('new-1');
    // Everything else about the row survives.
    expect(remapRow(row, remap).data).toEqual({ name: 'Ada' });
  });

  it('repoints a view instance at BOTH its new table and its new template', () => {
    const remap = buildRemap(meta, 'demo-2', counter());
    const out = applyRemap(meta, remap);
    const vi = out.viewInstances[0]!;
    expect(vi.id).toBe('new-4');
    expect(vi.workspaceId).toBe('demo-2');
    expect(vi.tableId).toBe('new-1');
    expect(vi.templateId).toBe('new-3');
    // A dangling templateId would render the view against nothing.
    expect(out.viewTemplates[0]!.id).toBe('new-3');
  });

  it('leaves settings and plugin records alone', () => {
    const out = applyRemap(meta, buildRemap(meta, 'demo-2', counter()));
    // The target store re-keys settings from its own active workspace, and plugin
    // records are this device's cache rather than workspace data.
    expect(out.settings).toEqual(meta.settings);
    expect(out.plugins).toEqual(meta.plugins);
  });

  it('mints a distinct id per document', () => {
    const remap = buildRemap(meta, 'demo-2', counter());
    const all = [...remap.tables.values(), ...remap.templates.values(), ...remap.instances.values()];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('legacyTableIds', () => {
  it('reverses the table map, so a reader can find the rows again', () => {
    const remap = buildRemap(meta, 'demo-2', counter());
    const back = legacyTableIds(remap);
    expect(back.get('new-1')).toBe('t-people');
    expect(back.get('new-2')).toBe('t-pets');
  });

  it('is empty for an identity remap, so lookups fall through to the id given', () => {
    expect(legacyTableIds(identityRemap('demo')).size).toBe(0);
  });
});
