import { filesystemStoreAdapter } from './fs-store.js';
import { sqliteStoreAdapter } from './sqlite-store.js';
import type { StoreAdapter } from './types.js';

export type StoreKind = 'fs' | 'sqlite';

export interface StoreFactoryEnv {
  STORAGE_KIND?: string | undefined;
  STORAGE_PATH?: string | undefined;
}

/**
 * Adding a new adapter is one import + one case below.
 * STORAGE_PATH is a directory for both adapters:
 *   - fs:     directory holding ${id}.db.json files
 *   - sqlite: directory holding ${id}.db files (one SQLite DB per workspace)
 */
export function createStoreFromEnv(env: StoreFactoryEnv = process.env): StoreAdapter {
  const kind = (env.STORAGE_KIND ?? 'fs').toLowerCase();
  const path = env.STORAGE_PATH;
  if (!path) {
    throw new Error('STORAGE_PATH is required');
  }
  return createStore(kind as StoreKind, path);
}

export function createStore(kind: StoreKind, path: string): StoreAdapter {
  switch (kind) {
    case 'fs':
      return filesystemStoreAdapter(path);
    case 'sqlite':
      return sqliteStoreAdapter(path);
    default: {
      const _exhaustive: never = kind;
      throw new Error(`unknown STORAGE_KIND: ${String(_exhaustive)}`);
    }
  }
}
