import type { HostApi, PluginModule, Row, Table } from '@easydb/shared';
// Type-only: erased at compile time, so importing this module for its type
// never pulls in `lit`/`top-progress.js` at runtime (that module registers a
// custom element on import, which would blow up under Vitest's default
// Node environment). The actual class is loaded lazily via dynamic import()
// only inside pull(), below.
import type { ProgressHandle } from '../chrome/top-progress.js';

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
    icon: 'cloud_upload',
    tooltip: 'Push the current workspace to a GitHub Gist',
    onClick: async () => {
      try {
        await push(api);
      } catch (err) {
        api.ui.dialogs.toast(`Push failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Gist sync',
        });
      }
    },
  });
  api.ui.registerFooterButton({
    id: 'gist-sync:pull',
    label: 'Pull',
    icon: 'cloud_download',
    tooltip: 'Pull the latest tables from the configured Gist',
    onClick: async () => {
      try {
        await pull(api);
      } catch (err) {
        api.ui.dialogs.toast(`Pull failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Gist sync',
        });
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
  const input = await api.ui.dialogs.prompt(
    'Connection string format:\nuser=<github-user>;gist_id=<id>;gist_token=<pat>;\n\nLeave gist_id empty to create a new gist on first Push.',
    '',
    'Gist credentials',
  );
  if (!input) return null;
  const parsed = parseConnectionString(input);
  if (!parsed) {
    await api.ui.dialogs.alert(
      'Could not parse connection string. Make sure it contains user=… and gist_token=….',
      'Gist credentials',
    );
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
    await api.ui.dialogs.alert(
      'Nothing to push: the current workspace has no tables.',
      'Gist sync',
    );
    return;
  }

  // Two size tiers. HARD: Gist rejects a file over 100 MB outright. SOFT: over
  // ~10 MB GitHub stops returning the file's inline `content` from the API (only
  // a raw_url), and both push and pull get slow and flaky — worth a heads-up
  // even though the pull side now reconstructs large files via raw_url.
  const HARD_LIMIT = 100_000_000;
  const SOFT_LIMIT = 10_000_000;
  const files: Record<string, { content: string }> = {};
  const oversize: string[] = [];
  const large: string[] = [];
  for (const t of tables) {
    const rows = await api.store.rows(t.id).find();
    const content = JSON.stringify(tableToFile(t, rows), null, 2);
    const label = `${t.name} (${(content.length / 1_000_000).toFixed(2)} MB)`;
    if (content.length > HARD_LIMIT) oversize.push(label);
    else if (content.length > SOFT_LIMIT) large.push(label);
    files[`${slug(t.name)}.table.json`] = { content };
  }

  // Warn before an oversized/heavy push (a single dialog covers both tiers) so
  // the user isn't surprised by a GitHub rejection or a sluggish sync.
  // https://github.com/orgs/community/discussions/147837
  if (oversize.length > 0 || large.length > 0) {
    const parts: string[] = [];
    if (oversize.length > 0)
      parts.push(
        `Over Gist's 100 MB per-file limit — GitHub will REJECT these:\n${oversize.join('\n')}`,
      );
    if (large.length > 0)
      parts.push(`Large (over 10 MB) — Gist sync will be slow and less reliable:\n${large.join('\n')}`);
    const proceed = await api.ui.dialogs.confirm(
      `${parts.join('\n\n')}\n\nTo reduce size: remove unnecessary columns, limit the number of rows, ` +
        `or mark the table no-persist/no-sync.\n\nPush anyway?`,
      'Gist size warning',
    );
    if (!proceed) return;
  }

  // Marker file so we can detect that a gist was produced by easyDBAccess
  // when pulling (vs. some unrelated gist the user pointed at by accident).
  files['_easydb.workspace.json'] = {
    content: JSON.stringify(
      { workspaceId: wsId, exportedAt: Date.now(), kind: 'easydb-workspace-v1' },
      null,
      2,
    ),
  };

  let updated: { id: string; html_url?: string };
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

  const url = updated.html_url ?? `https://gist.github.com/${creds.user}/${updated.id}`;
  api.ui.dialogs.toast(`Pushed ${tables.length} table${tables.length === 1 ? '' : 's'}.  ${url}`, {
    kind: 'success',
    title: 'Gist sync',
  });
}

// -- Pull ---------------------------------------------------------------------

async function pull(api: HostApi): Promise<void> {
  const creds = await ensureCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert(
      'No gist id configured for this workspace. Push first or set it via the connection string.',
      'Gist sync',
    );
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
  const gist = (await res.json()) as {
    files: Record<string, { content: string; truncated?: boolean; raw_url?: string }>;
  };

  const tableFiles = Object.entries(gist.files).filter(
    ([name]) => name.endsWith('.table.json') && !name.startsWith('_easydb'),
  );
  if (tableFiles.length === 0) {
    await api.ui.dialogs.alert('Gist contains no .table.json files.', 'Gist sync');
    return;
  }

  // Index existing tables by name so we upsert instead of duplicating.
  const existingTables = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  const byName = new Map(existingTables.map((t) => [t.name, t]));

  const { TopProgress } = await import('../chrome/top-progress.js');
  const progress: ProgressHandle = TopProgress.begin('Pulling from gist…');

  let imported = 0;
  const failures: Array<{ file: string; error: string }> = [];
  try {
    for (const [i, [name, file]] of tableFiles.entries()) {
      try {
        const content = await fetchGistFileContent(file);
        const parsed = JSON.parse(content) as {
          name: string;
          columns: Table['columns'];
          rows: Array<Row['data']>;
        };
        if (!parsed.name || !Array.isArray(parsed.columns)) {
          throw new Error('unexpected file shape (missing name/columns)');
        }

        let table: Table;
        const existing = byName.get(parsed.name);
        if (existing) {
          table = await api.store.tables.patch(existing.id, {
            columns: parsed.columns,
            updatedAt: Date.now(),
          });
          // Wipe existing rows for clean reimport (simplest correct behavior).
          const rowColl = api.store.rows(existing.id);
          const oldRows = await rowColl.find();
          await rowColl.bulkRemove(oldRows.map((r) => r.id));
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

        const docs = (parsed.rows ?? []).map((data) => ({
          id: cryptoUUID(),
          tableId: table.id,
          data,
          updatedAt: Date.now(),
        }));
        await api.store.rows(table.id).bulkInsert(docs);

        imported++;
      } catch (err) {
        failures.push({ file: name, error: (err as Error).message });
      } finally {
        progress.fraction((i + 1) / tableFiles.length);
      }
    }
  } finally {
    progress.done();
  }

  if (failures.length > 0) {
    const list = failures.map((f) => `• ${f.file}: ${f.error}`).join('\n');
    api.ui.dialogs.toast(
      `Pulled ${imported} of ${tableFiles.length} tables. ${failures.length} failed:\n${list}`,
      { kind: 'warning', title: 'Gist sync' },
    );
  } else {
    api.ui.dialogs.toast(
      `Pulled ${imported} table${imported === 1 ? '' : 's'} from gist ${creds.gistId}.`,
      { kind: 'success', title: 'Gist sync' },
    );
  }
}

// -- helpers ------------------------------------------------------------------

function tableToFile(t: Table, rows: Row[]) {
  return {
    name: t.name,
    columns: t.columns,
    rows: rows.map((r) => r.data),
  };
}

/**
 * Resolve a gist file's FULL content. GitHub truncates the inline `content` of
 * large gist files (setting `truncated: true` + a `raw_url` to the full body);
 * blindly parsing the truncated string is what caused "Pull failed: Expected
 * double-quoted property name…". When truncated, fetch the raw_url — a secret
 * gist's raw_url is link-accessible and served with `Access-Control-Allow-Origin: *`,
 * so a plain GET (no auth header → no CORS preflight) works from the browser.
 */
export async function fetchGistFileContent(
  file: { content: string; truncated?: boolean; raw_url?: string },
  doFetch: (url: string) => Promise<Response> = (u) => fetch(u),
): Promise<string> {
  if (!file.truncated) return file.content;
  if (!file.raw_url) throw new Error('GitHub truncated this file but returned no raw_url');
  const res = await doFetch(file.raw_url);
  if (!res.ok) throw new Error(`raw fetch failed: ${res.status} ${res.statusText}`);
  return res.text();
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
