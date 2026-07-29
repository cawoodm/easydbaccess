// packages/renderer/src/plugins/url-source.ts
//
// A "reference" table is a live, read-only window onto a plain CSV or JSON
// file published somewhere on the web (not a Datasette instance — that has
// its own dedicated provider in datasette-collection.ts). A Table carrying
// `source: { type: 'url', config: { url, format } }` routes its rows here
// instead of Dexie: every render re-fetches (or reuses a cached fetch of)
// the URL and parses it into rows on the fly.
//
// It is read-only and never persisted for the same reason a Datasette
// connection's writes are gated — except more so: a bare CSV/JSON URL has no
// write API at all, no primary key contract, and no server-side concurrency
// story. Caching rows locally would also silently drift from the source and
// get swept into `/sync` as if it were the user's own data. If someone wants
// to edit what they see, the answer is "import a copy" (csv-import /
// json-import), which makes a normal local table with its own identity.

import type {
  DataCollection,
  HostApi,
  PluginModule,
  Row,
  RowSourceCtx,
  Table,
  Unsubscribe,
} from '@easydb/shared';
import { parseCsv } from './csv-import.js';
import {
  isGitLfsPointer,
  readResponseText,
  toCorsFriendlyUrl,
  toGitLfsMediaUrl,
} from './read-url.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'url-source',
  name: 'URL Reference',
  type: 'source',
  version: '0.1.0',
  description:
    'Backs a table with a live read-only fetch of a plain CSV or JSON URL — a "reference" table whose rows are never persisted locally.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/url-source.ts',
};

export function init(api: HostApi): void {
  if (typeof api.registerRowSource === 'function') {
    api.registerRowSource({ type: 'url', create: createUrlCollection });
  }

  // A Refresh button for URL references: re-fetch the source, bypassing the
  // collection's cache. Shown only on `url`-backed (reference) tables.
  api.ui.registerTableButton({
    id: 'url-source:refresh',
    label: 'Refresh',
    icon: 'refresh',
    tooltip: 'Re-fetch this reference from its source URL',
    visible: (table) => table.source?.type === 'url',
    onClick: async (a, { tableId }) => {
      try {
        const coll = a.store.rows(tableId);
        if (typeof coll.refresh === 'function') await coll.refresh();
        a.ui.dialogs.toast('Reference refreshed.', { kind: 'success', title: 'Refresh' });
      } catch (err) {
        a.ui.dialogs.toast(`Refresh failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Refresh',
        });
      }
    },
  });
}

/** Thrown for any write attempted against a reference (read-only) table. */
export class ReadOnlyReferenceError extends Error {
  constructor(op: string) {
    super(`This is a reference (read-only) table — ${op} is not permitted. Import a copy to edit.`);
    this.name = 'ReadOnlyReferenceError';
  }
}

export interface UrlSourceConfig {
  url: string;
  format: 'csv' | 'json';
}

function matchesQuery(row: Row, query: Partial<Row>): boolean {
  for (const [k, v] of Object.entries(query)) {
    if (k === 'data') continue; // object equality is meaningless here
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

/**
 * Turn a JSON-parsed value into an array of plain row records. Accepts a
 * top-level array of objects, or an object whose first array-valued property
 * (preferring `rows` / `records` / `data`) holds the objects.
 */
function jsonToRecords(parsed: unknown): Array<Record<string, unknown>> {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (Array.isArray(parsed)) {
    return parsed.filter(isObj);
  }
  if (isObj(parsed)) {
    for (const key of ['rows', 'records', 'data']) {
      const v = parsed[key];
      if (Array.isArray(v)) return v.filter(isObj);
    }
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) return v.filter(isObj);
    }
  }
  return [];
}

/**
 * Build the live read-only collection for a table sourced from a plain
 * CSV/JSON URL. All I/O goes through `ctx.backend.fetch`, so it stays
 * unit-testable and works both in the browser (direct) and Electron (proxied).
 */
export function createUrlCollection(table: Table, ctx: RowSourceCtx): DataCollection<Row> {
  const cfg = (table.source?.config ?? {}) as unknown as Partial<UrlSourceConfig>;
  const url = typeof cfg.url === 'string' ? cfg.url : '';
  const format = cfg.format === 'json' ? 'json' : 'csv';

  const subscribers = new Set<(rows: Row[]) => void>();
  let cache: Row[] = [];
  let loaded = false;
  let inFlight: Promise<Row[]> | null = null;

  function toRows(records: Array<Record<string, unknown>>): Row[] {
    return records.map((data, i) => ({ id: `url:${i}`, tableId: table.id, data, updatedAt: 0 }));
  }

  async function readText(target: string): Promise<string> {
    let res: Response;
    try {
      res = await ctx.backend.fetch(target);
    } catch (err) {
      throw new Error(`Could not reach ${url}: ${(err as Error)?.message ?? String(err)}`);
    }
    if (!res.ok) {
      throw new Error(`Could not load ${url}: HTTP ${res.status} ${res.statusText}`);
    }
    try {
      return await readResponseText(res);
    } catch (err) {
      throw new Error(
        `Could not read response from ${url}: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  async function fetchAndParse(): Promise<Array<Record<string, unknown>>> {
    if (!url) throw new Error('This reference table has no URL configured.');
    const cors = toCorsFriendlyUrl(url);
    let text = await readText(cors);
    // GitHub's raw host answers 200 with an LFS pointer stub for LFS-tracked
    // files; the real bytes live on the media host.
    if (isGitLfsPointer(text)) {
      const media = toGitLfsMediaUrl(cors);
      if (media) text = await readText(media);
    }
    try {
      if (format === 'json') {
        return jsonToRecords(JSON.parse(text));
      }
      return parseCsv(text).rows;
    } catch (err) {
      throw new Error(
        `Could not parse ${format.toUpperCase()} from ${url}: ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  // Materialise rows, collapsing concurrent callers onto a single request —
  // the grid both subscribes AND calls find() on mount, so without this a
  // fresh reference table would fire the fetch twice on open.
  function loadAll(): Promise<Row[]> {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const records = await fetchAndParse();
        cache = toRows(records);
        loaded = true;
        for (const fn of subscribers) fn(cache);
        return cache;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    async find(query) {
      const rows = loaded ? cache : await loadAll();
      if (!query || Object.keys(query).length === 0) return rows;
      return rows.filter((r) => matchesQuery(r, query));
    },

    async findOne(id) {
      const rows = loaded ? cache : await loadAll();
      return rows.find((r) => r.id === id) ?? null;
    },

    async insert() {
      throw new ReadOnlyReferenceError('insert');
    },

    async bulkInsert() {
      throw new ReadOnlyReferenceError('insert');
    },

    async upsert() {
      throw new ReadOnlyReferenceError('upsert');
    },

    async patch() {
      throw new ReadOnlyReferenceError('update');
    },

    async remove() {
      throw new ReadOnlyReferenceError('delete');
    },

    async bulkRemove() {
      throw new ReadOnlyReferenceError('delete');
    },

    subscribe(fn): Unsubscribe {
      subscribers.add(fn);
      // Deliver the cache if we already have it; only hit the network when we
      // haven't loaded yet (find() on the same instance shares the request).
      if (loaded) fn(cache);
      else void loadAll();
      return () => {
        subscribers.delete(fn);
      };
    },

    // Force a fresh fetch (bypassing the `loaded` cache) and notify
    // subscribers — powers the per-table "Refresh" button.
    async refresh() {
      loaded = false;
      cache = [];
      await loadAll();
    },
  };
}
