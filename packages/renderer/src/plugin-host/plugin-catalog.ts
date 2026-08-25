// packages/renderer/src/plugin-host/plugin-catalog.ts
//
// What a plugin catalog is, and how to read one.
//
// Two things read catalogs now — the Plugin Manager dialog, which lists them, and
// the `new-plugins` plugin, which notices arrivals — so the shape, the default URL
// and the settings key live in one place rather than in two copies that drift.
//
// A catalog is `{ plugins: [...] }`. `public/plugins/catalog.json` is the built-in
// one and is GENERATED (see `scripts/generate-plugin-catalog.mjs`); a server's
// `/plugins/registry` answers the same shape, which is why one reader serves both.

import type { PluginType } from '@easydb/shared';

/** One plugin offered by a catalog. `url` may be relative to the catalog itself. */
export interface CatalogEntry {
  id: string;
  name: string;
  type?: PluginType;
  description?: string;
  author?: string;
  icon?: string;
  repo?: string;
  /** Resolved against the catalog URL — may be relative (./foo.js) or absolute. */
  url: string;
}

/** A catalog entry with its install URL made absolute — what goes into `pluginUrls`. */
export interface CatalogResolved extends CatalogEntry {
  absUrl: string;
}

/** Settings key holding the catalog source URLs the user has used. */
export const CATALOG_URLS_SETTING = 'plugin:catalogUrls';

/** The catalog this build ships with. Same origin, so reading it is nearly free. */
export function defaultCatalogUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}plugins/catalog.json`, location.origin).toString();
}

/**
 * Entries with their URLs resolved. Pure, so the resolution rule is testable
 * without a network: `./cell-email.js` in a catalog at `/plugins/catalog.json` is
 * `/plugins/cell-email.js`, and an entry that is already absolute is left alone.
 */
export function resolveCatalog(entries: readonly CatalogEntry[], catalogUrl: string): CatalogResolved[] {
  return entries.map((e) => ({ ...e, absUrl: new URL(e.url, catalogUrl).toString() }));
}

/**
 * Fetch and resolve one catalog. **Throws** on a bad response or bad JSON — every
 * caller wants to say something different about a catalog it could not read.
 *
 * `no-store`, because the question both callers ask is "what is in it NOW", and a
 * cached copy is exactly the answer that hides a new plugin.
 */
export async function fetchCatalog(catalogUrl: string): Promise<CatalogResolved[]> {
  const res = await fetch(catalogUrl, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { plugins?: CatalogEntry[] };
  return resolveCatalog(Array.isArray(json.plugins) ? json.plugins : [], catalogUrl);
}
