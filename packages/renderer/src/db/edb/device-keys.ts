// packages/renderer/src/db/edb/device-keys.ts
//
// The names of the device-state keys that are NOT settings.
//
// A leaf module with no imports, which is the whole point. `device-state.ts` has
// to list every key the folder owns, and `folder-index.ts` / `space-registry.ts`
// have to read and write them — so the names have to be reachable from both
// without either importing the other. Putting them in `device-state.ts` would
// drag the worker bridge, the store adapter and the write guard into the import
// graph of a pure cache; putting them in `folder-index.ts` would do the same to
// `device-state.ts` in the other direction.

/** What the last folder scan found: one entry per workspace, plus every file name seen. */
export const FOLDER_INDEX_KEY = 'eda:folderIndex';

/** Which `.edb` files of the folder THIS device uses. Deliberately not folder-owned. */
export const FOLDER_SELECTION_KEY = 'eda:folderFiles';

/** The workspaces each database holds, by database name. See `space-registry.ts`. */
export const SPACE_REGISTRY_KEY = 'eda:spaceRegistry';
