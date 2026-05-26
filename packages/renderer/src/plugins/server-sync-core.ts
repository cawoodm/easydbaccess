import type { HostApi, Row, Table } from '@easydb/shared';
import { parsedToTables } from './json-import.js';

/**
 * Shared helpers between `server-sync` (manual Push/Pull buttons) and
 * `auto-sync` (background poll + silent push). Pure data ops — no UI, no
 * events. Both plugins read and write the same settings keys so a single URL
 * + ETag pair is shared.
 */

export const URL_KEY = 'server-sync:url';
export function etagKey(wsId: string): string {
  return `server-sync:etag:${wsId}`;
}

export async function loadServerUrl(api: HostApi): Promise<string | null> {
  const s = await api.store.settings.findOne(URL_KEY);
  const v = s?.value;
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.replace(/\/+$/, '');
}

export async function saveServerUrl(api: HostApi, url: string): Promise<void> {
  await api.store.settings.upsert({ key: URL_KEY, value: url.replace(/\/+$/, '') });
}

export async function loadEtag(api: HostApi, wsId: string): Promise<string | null> {
  const s = await api.store.settings.findOne(etagKey(wsId));
  const v = s?.value;
  return typeof v === 'string' ? v : null;
}

export async function saveEtag(api: HostApi, wsId: string, etag: string): Promise<void> {
  await api.store.settings.upsert({ key: etagKey(wsId), value: etag });
}

export function stripEtag(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/**
 * Normalize a dump body for equality comparison. Strips `exportedAt` (which
 * is Date.now() inside serializeWorkspace so two back-to-back serializations
 * never byte-equal) and round-trips through JSON to collapse whitespace
 * differences between local pretty-print and server's compact response.
 */
export function canonicalize(body: string): string {
  try {
    const obj = JSON.parse(body) as Record<string, unknown> | null;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      delete (obj as { exportedAt?: number }).exportedAt;
    }
    return JSON.stringify(obj);
  } catch {
    return body;
  }
}

/**
 * Replace the current workspace's tables and rows with a parsed dump.
 * Mirrors server-sync's pull behavior: wipe everything, then insert. Used by
 * the manual Pull button and by auto-sync after the user confirms a pull.
 *
 * Returns the number of tables imported.
 */
export async function replaceWorkspace(
  api: HostApi,
  wsId: string,
  dump: unknown,
): Promise<number> {
  const tables = parsedToTables(dump, wsId);

  const existing = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  for (const t of existing) {
    const rowColl = api.store.rows(t.id);
    const rows = await rowColl.find();
    await rowColl.bulkRemove(rows.map((r) => r.id));
    await api.store.tables.remove(t.id);
  }

  let imported = 0;
  for (const t of tables) {
    const tableId = cryptoUUID();
    const inserted: Table = await api.store.tables.insert({
      id: tableId,
      workspaceId: wsId,
      name: t.name,
      code: slug(t.name),
      columns: t.columns,
      view: 'table',
      ...(t.windowGeometry ? { windowGeometry: t.windowGeometry } : {}),
      ...(t.sortColumn ? { sortColumn: t.sortColumn, sortAsc: t.sortAsc ?? true } : {}),
      updatedAt: Date.now(),
    });
    const docs: Row[] = t.rows.map((row) => ({
      id: cryptoUUID(),
      tableId: inserted.id,
      data: row,
      updatedAt: Date.now(),
    }));
    await api.store.rows(inserted.id).bulkInsert(docs);
    imported++;
  }
  return imported;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

export function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
