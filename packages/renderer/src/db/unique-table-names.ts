// packages/renderer/src/db/unique-table-names.ts
//
// Two tables in one workspace may never share a name. This is not a nicety:
// projections and view instances bind to their source BY NAME (see the
// "Projections bind to their sources BY NAME" rule in CLAUDE.md), so a
// duplicate name makes a reference ambiguous — it resolves to whichever row
// the query returns first.
//
// The columns editor has always refused a clash, but it is one writer of many.
// Dropping a `.table.json` and answering "Add as new tables" wrote the dump's
// name verbatim and produced two tables called the same thing, and every
// importer carried its own (or no) uniquing rule. So the STORE enforces it,
// which is the only place that sees every write.
//
// The write is never rejected. A rejection would abort a gist pull or a dump
// restore halfway through, and the caller has no way to recover mid-loop; a
// renamed table is recoverable by hand. Callers that must show the name use the
// returned document, which carries the name that was actually stored.

import type { DataCollection, Table } from '@easydb/shared';
import { slugTable } from '../util/ids.js';
import { uniqueTableName } from '../util/table-names.js';

/**
 * Wrap the `tables` collection so no write can create a second table with a
 * name another table in the same workspace already uses. A colliding name is
 * uniqued by {@link uniqueTableName} (`places` → `places-2`), and `code` is
 * re-derived so it keeps matching the stored name.
 */
export function withUniqueTableNames(tables: DataCollection<Table>): DataCollection<Table> {
  /** Names used by OTHER tables in this workspace. `exceptId` is the writer's own row. */
  const takenIn = async (workspaceId: string, exceptId: string): Promise<string[]> => (await tables.find()).filter((t) => t.workspaceId === workspaceId && t.id !== exceptId).map((t) => t.name);

  /** The doc as it should be stored: same object unless the name had to change. */
  const resolve = (doc: Table, taken: Iterable<string>): Table => {
    const name = uniqueTableName(taken, doc.name);
    if (name === doc.name) return doc;
    // eslint-disable-next-line no-console
    console.warn(`[store] "${doc.name}" is taken in this workspace — stored as "${name}"`);
    return { ...doc, name, code: slugTable(name) };
  };

  return {
    ...tables,
    async insert(doc) {
      return tables.insert(resolve(doc, await takenIn(doc.workspaceId, doc.id)));
    },
    async bulkInsert(docs) {
      if (docs.length === 0) return tables.bulkInsert(docs);
      // One read, then the names assigned inside this batch join `taken` as they
      // are decided — two tables of the same name in one dump collide with each
      // other, not only with what is already stored.
      const taken = new Set((await tables.find()).filter((t) => t.workspaceId === docs[0]!.workspaceId).map((t) => t.name));
      const out = docs.map((doc) => {
        const resolved = resolve(doc, taken);
        taken.add(resolved.name);
        return resolved;
      });
      return tables.bulkInsert(out);
    },
    async upsert(doc) {
      return tables.upsert(resolve(doc, await takenIn(doc.workspaceId, doc.id)));
    },
    async patch(id, patch) {
      if (typeof patch.name !== 'string') return tables.patch(id, patch);
      const current = await tables.findOne(id);
      if (!current) return tables.patch(id, patch); // let the store report the miss
      const name = uniqueTableName(await takenIn(current.workspaceId, id), patch.name);
      if (name === patch.name) return tables.patch(id, patch);
      // eslint-disable-next-line no-console
      console.warn(`[store] "${patch.name}" is taken in this workspace — renamed to "${name}"`);
      return tables.patch(id, { ...patch, name, code: slugTable(name) });
    },
  };
}
