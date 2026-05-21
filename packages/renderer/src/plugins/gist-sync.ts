import type { HostApi, PluginModule, Row, Table } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'gist-sync',
  version: '0.1.0',
  description: 'Push and pull the current workspace to a private GitHub Gist.',
  author: 'easyDBAccess built-ins',
};

interface GistCreds {
  user: string;
  gistId: string;
  token: string;
}

const SETTING_KEY_PREFIX = 'gist:';

export function init(api: HostApi): void {
  api.ui.registerFooterButton({
    id: 'gist-sync:push',
    label: 'Push',
    tooltip: 'Push the current workspace to a GitHub Gist',
    onClick: async () => {
      try {
        await push(api);
      } catch (err) {
        alert(`Push failed: ${(err as Error).message}`);
      }
    },
  });
  api.ui.registerFooterButton({
    id: 'gist-sync:pull',
    label: 'Pull',
    tooltip: 'Pull the latest tables from the configured Gist',
    onClick: async () => {
      try {
        await pull(api);
      } catch (err) {
        alert(`Pull failed: ${(err as Error).message}`);
      }
    },
  });
}

// -- Credentials --------------------------------------------------------------

async function settingKey(api: HostApi): Promise<string> {
  const wsId = api.workspaceId();
  return `${SETTING_KEY_PREFIX}${wsId ?? 'default'}`;
}

async function loadCreds(api: HostApi): Promise<GistCreds | null> {
  const key = await settingKey(api);
  const s = await api.store.settings.findOne(key);
  if (!s) return null;
  const v = s.value as Partial<GistCreds> | null | undefined;
  if (!v || !v.token || !v.user) return null;
  return { user: v.user, gistId: v.gistId ?? '', token: v.token };
}

async function saveCreds(api: HostApi, creds: GistCreds): Promise<void> {
  const key = await settingKey(api);
  await api.store.settings.upsert({ key, value: creds });
}

/**
 * Connection-string interface preserves the original minniDBMax UX:
 *   user=marc;gist_id=abc123;gist_token=ghp_xxx;
 * The user pastes once; we parse, store, and never prompt again unless the
 * stored token is rejected by GitHub.
 */
function parseConnectionString(raw: string): GistCreds | null {
  const parts: Record<string, string> = {};
  for (const seg of raw.split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq).trim();
    const v = seg.slice(eq + 1).trim();
    if (k) parts[k] = v;
  }
  if (!parts.user || !parts.gist_token) return null;
  return {
    user: parts.user,
    gistId: parts.gist_id ?? '',
    token: parts.gist_token,
  };
}

async function ensureCreds(api: HostApi): Promise<GistCreds | null> {
  const existing = await loadCreds(api);
  if (existing) return existing;
  const input = window.prompt(
    'Gist connection string\n\nFormat: user=<github-user>;gist_id=<id>;gist_token=<pat>;\n\n(Leave gist_id empty to create a new gist on first Push.)',
    '',
  );
  if (!input) return null;
  const parsed = parseConnectionString(input);
  if (!parsed) {
    alert('Could not parse connection string. Make sure it contains user=… and gist_token=….');
    return null;
  }
  await saveCreds(api, parsed);
  return parsed;
}

// -- Push ---------------------------------------------------------------------

async function push(api: HostApi): Promise<void> {
  const creds = await ensureCreds(api);
  if (!creds) return;

  const wsId = api.workspaceId();
  if (!wsId) throw new Error('no active workspace');

  const tables = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  if (tables.length === 0) {
    alert('Nothing to push: the current workspace has no tables.');
    return;
  }

  const files: Record<string, { content: string }> = {};
  for (const t of tables) {
    const rows = await api.store.rows(t.id).find();
    files[`${slug(t.name)}.table.json`] = {
      content: JSON.stringify(tableToFile(t, rows), null, 2),
    };
  }

  // Marker file so we can detect that a gist was produced by easyDBAccess
  // when pulling (vs. some unrelated gist the user pointed at by accident).
  files['_easydb.workspace.json'] = {
    content: JSON.stringify({ workspaceId: wsId, exportedAt: Date.now(), kind: 'easydb-workspace-v1' }, null, 2),
  };

  let updated: { id: string };
  if (creds.gistId) {
    const res = await fetch(`https://api.github.com/gists/${creds.gistId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files, description: `easyDBAccess workspace: ${wsId}` }),
    });
    if (!res.ok) throw new Error(await readError(res));
    updated = await res.json();
  } else {
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        public: false,
        description: `easyDBAccess workspace: ${wsId}`,
        files,
      }),
    });
    if (!res.ok) throw new Error(await readError(res));
    updated = await res.json();
    creds.gistId = updated.id;
    await saveCreds(api, creds);
  }

  alert(
    `Pushed ${tables.length} table${tables.length === 1 ? '' : 's'} to gist ${updated.id}.`,
  );
}

// -- Pull ---------------------------------------------------------------------

async function pull(api: HostApi): Promise<void> {
  const creds = await ensureCreds(api);
  if (!creds || !creds.gistId) {
    alert('No gist id configured for this workspace. Push first or set it via the connection string.');
    return;
  }

  const wsId = api.workspaceId();
  if (!wsId) throw new Error('no active workspace');

  const res = await fetch(`https://api.github.com/gists/${creds.gistId}`, {
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(await readError(res));
  const gist = (await res.json()) as { files: Record<string, { content: string }> };

  const tableFiles = Object.entries(gist.files).filter(
    ([name]) => name.endsWith('.table.json') && !name.startsWith('_easydb'),
  );
  if (tableFiles.length === 0) {
    alert('Gist contains no .table.json files.');
    return;
  }

  // Index existing tables by name so we upsert instead of duplicating.
  const existingTables = (await api.store.tables.find()).filter(
    (t) => t.workspaceId === wsId,
  );
  const byName = new Map(existingTables.map((t) => [t.name, t]));

  let imported = 0;
  for (const [, file] of tableFiles) {
    const parsed = JSON.parse(file.content) as { name: string; columns: Table['columns']; rows: Array<Row['data']> };
    if (!parsed.name || !Array.isArray(parsed.columns)) continue;

    let table: Table;
    const existing = byName.get(parsed.name);
    if (existing) {
      table = await api.store.tables.patch(existing.id, {
        columns: parsed.columns,
        updatedAt: Date.now(),
      });
      // Wipe existing rows for clean reimport (simplest correct behavior).
      const oldRows = await api.store.rows(existing.id).find();
      for (const r of oldRows) await api.store.rows(existing.id).remove(r.id);
    } else {
      table = await api.store.tables.insert({
        id: cryptoUUID(),
        workspaceId: wsId,
        name: parsed.name,
        code: slug(parsed.name),
        columns: parsed.columns,
        view: 'table',
        updatedAt: Date.now(),
      });
    }

    for (const data of parsed.rows ?? []) {
      await api.store.rows(table.id).insert({
        id: cryptoUUID(),
        tableId: table.id,
        data,
        updatedAt: Date.now(),
      });
    }
    imported++;
  }

  alert(`Pulled ${imported} table${imported === 1 ? '' : 's'} from gist ${creds.gistId}.`);
}

// -- helpers ------------------------------------------------------------------

function tableToFile(t: Table, rows: Row[]) {
  return {
    name: t.name,
    columns: t.columns,
    rows: rows.map((r) => r.data),
  };
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
