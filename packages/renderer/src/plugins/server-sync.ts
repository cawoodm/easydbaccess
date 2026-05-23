import type { HostApi, PluginModule, Row, Table } from '@easydb/shared';
import { serializeWorkspace } from './dump-export.js';
import { parsedToTables } from './json-import.js';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'server-sync',
  version: '0.1.0',
  description: 'Push and pull the current workspace to an easyDBAccess Hono backend.',
  author: 'easyDBAccess built-ins',
};

const URL_KEY = 'server-sync:url';
const etagKey = (wsId: string) => `server-sync:etag:${wsId}`;

export function init(api: HostApi): void {
  api.ui.registerFooterButton({
    id: 'server-sync:push',
    label: 'Sync ↑',
    icon: 'cloud_upload',
    tooltip: 'Push this workspace to the configured server',
    onClick: async () => {
      try {
        await push(api);
      } catch (err) {
        api.ui.dialogs.toast(`Push failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Server sync',
        });
      }
    },
  });
  api.ui.registerFooterButton({
    id: 'server-sync:pull',
    label: 'Sync ↓',
    icon: 'cloud_download',
    tooltip: 'Pull this workspace from the configured server',
    onClick: async () => {
      try {
        await pull(api);
      } catch (err) {
        api.ui.dialogs.toast(`Pull failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Server sync',
        });
      }
    },
  });
}

// -- Config -------------------------------------------------------------------

async function loadServerUrl(api: HostApi): Promise<string | null> {
  const s = await api.store.settings.findOne(URL_KEY);
  const v = s?.value;
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.replace(/\/+$/, '');
}

async function saveServerUrl(api: HostApi, url: string): Promise<void> {
  await api.store.settings.upsert({ key: URL_KEY, value: url.replace(/\/+$/, '') });
}

async function ensureServerUrl(api: HostApi): Promise<string | null> {
  const existing = await loadServerUrl(api);
  if (existing) return existing;
  const input = await api.ui.dialogs.prompt(
    'Server URL (e.g. http://localhost:3000):',
    'http://localhost:3000',
    'Server sync',
  );
  if (!input) return null;
  try {
    new URL(input);
  } catch {
    await api.ui.dialogs.alert(`"${input}" is not a valid URL.`, 'Server sync');
    return null;
  }
  await saveServerUrl(api, input);
  return input.replace(/\/+$/, '');
}

async function loadEtag(api: HostApi, wsId: string): Promise<string | null> {
  const s = await api.store.settings.findOne(etagKey(wsId));
  const v = s?.value;
  return typeof v === 'string' ? v : null;
}

async function saveEtag(api: HostApi, wsId: string, etag: string): Promise<void> {
  await api.store.settings.upsert({ key: etagKey(wsId), value: etag });
}

// -- Push ---------------------------------------------------------------------

async function push(api: HostApi): Promise<void> {
  const wsId = api.workspaceId();
  if (!wsId) throw new Error('no active workspace');
  const url = await ensureServerUrl(api);
  if (!url) return;

  const body = await serializeWorkspace(api);
  const etag = await loadEtag(api, wsId);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (etag) headers['If-Match'] = `"${etag}"`;

  let res = await fetch(`${url}/sync/${encodeURIComponent(wsId)}`, {
    method: 'PUT',
    headers,
    body,
  });

  // Conflict: server has newer data than we last saw. Ask whether to force.
  if (res.status === 412) {
    const data = (await res.json().catch(() => ({}))) as { currentEtag?: string };
    const forced = await api.ui.dialogs.confirm(
      `The server's copy of "${wsId}" has changed since you last pulled.\n\n` +
        `Push anyway and overwrite it? (Cancel to pull the server version first.)`,
      'Server sync — conflict',
    );
    if (!forced) {
      if (data.currentEtag) await saveEtag(api, wsId, data.currentEtag);
      api.ui.dialogs.toast('Push cancelled. Pull, merge locally, then push again.', {
        kind: 'warning',
        title: 'Server sync',
      });
      return;
    }
    res = await fetch(`${url}/sync/${encodeURIComponent(wsId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }, // no If-Match → force
      body,
    });
  }

  if (!res.ok) throw new Error(await readError(res));

  const newEtag = stripEtag(res.headers.get('ETag'));
  if (newEtag) await saveEtag(api, wsId, newEtag);

  api.ui.dialogs.toast(`Pushed workspace "${wsId}" to ${url}.`, {
    kind: 'success',
    title: 'Server sync',
  });
}

// -- Pull ---------------------------------------------------------------------

async function pull(api: HostApi): Promise<void> {
  const wsId = api.workspaceId();
  if (!wsId) throw new Error('no active workspace');
  const url = await ensureServerUrl(api);
  if (!url) return;

  const ok = await api.ui.dialogs.confirm(
    `Replace your local copy of "${wsId}" with the server's version?\n\n` +
      `Local tables that aren't on the server will be removed.`,
    'Server sync — pull',
  );
  if (!ok) return;

  const res = await fetch(`${url}/sync/${encodeURIComponent(wsId)}`);
  if (res.status === 404) {
    api.ui.dialogs.toast(
      `Workspace "${wsId}" doesn't exist on the server yet. Push first.`,
      { kind: 'warning', title: 'Server sync' },
    );
    return;
  }
  if (!res.ok) throw new Error(await readError(res));

  const etag = stripEtag(res.headers.get('ETag'));
  const dump = await res.json();
  const tables = parsedToTables(dump, wsId);

  // Replace-entire-workspace semantics: wipe everything, then insert.
  const existing = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  for (const t of existing) {
    const rows = await api.store.rows(t.id).find();
    for (const r of rows) await api.store.rows(t.id).remove(r.id);
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

  if (etag) await saveEtag(api, wsId, etag);
  api.ui.dialogs.toast(
    `Pulled ${imported} table${imported === 1 ? '' : 's'} from ${url}.`,
    { kind: 'success', title: 'Server sync' },
  );
}

// -- helpers ------------------------------------------------------------------

function stripEtag(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

async function readError(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'table'
  );
}

function cryptoUUID(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}
