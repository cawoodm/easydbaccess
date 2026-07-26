import type {
  HostApi,
  PluginModule,
  Row,
  Setting,
  Table,
  ViewInstance,
  ViewTemplate,
} from '@easydb/shared';
// Type-only: erased at compile time, so importing this module for its type
// never pulls in `lit`/`top-progress.js` at runtime (that module registers a
// custom element on import, which would blow up under Vitest's default
// Node environment). The actual class is loaded lazily via dynamic import()
// only inside pull(), below.
import type { ProgressHandle } from '../chrome/top-progress.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'gist-sync',
  name: 'Gist Sync',
  type: 'sync',
  version: '0.1.0',
  description: 'Push and pull the current workspace to a private GitHub Gist.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/gist-sync.ts',
};

interface GistCreds {
  user: string;
  gistId: string;
  token: string;
}

const SETTING_KEY_PREFIX = 'gist:';

// Settings whose keys start with any of these carry secrets or device-local
// state and must never be written into (or read back from) a gist.
const SECRET_SETTING_PREFIXES = ['gist:', 'datasette:token:', 'server-sync:'];

function isSyncableSetting(key: string): boolean {
  return !SECRET_SETTING_PREFIXES.some((prefix) => key.startsWith(prefix));
}

// GitHub's mark, inline — Material Icons has no GitHub glyph. The slot/footer
// icon renderers detect a leading `<svg` and render it as inline SVG.
const GITHUB_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.12-.3-.54-1.53.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/></svg>';

export function init(api: HostApi): void {
  api.ui.registerSettings('gist-sync', 'Gist Sync', [
    {
      key: 'user',
      label: 'GitHub user',
      type: 'string',
      scope: 'workspace',
      description: 'GitHub username that owns the gist.',
    },
    {
      key: 'gist_id',
      label: 'Gist ID',
      type: 'string',
      scope: 'workspace',
      description: 'Leave empty to create a new gist on the first Push.',
    },
    {
      key: 'gist_token',
      label: 'GitHub token (PAT)',
      type: 'secret',
      scope: 'user',
      description: 'Personal access token with the "gist" scope. Stored on this device only (not synced).',
    },
  ]);

  api.ui.registerFooterButton({
    id: 'gist-sync:menu',
    label: 'Gist',
    icon: GITHUB_ICON_SVG,
    tooltip: 'Gist sync — push, pull, share…',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect =
        ctx?.anchor?.getBoundingClientRect() ??
        new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'push', label: 'Push', icon: 'cloud_upload' },
        { id: 'pull', label: 'Pull', icon: 'cloud_download' },
        { id: 'settings', label: 'Settings', icon: 'settings' },
        { id: 'share', label: 'Share', icon: 'share' },
        { id: 'view', label: 'View gist', icon: 'open_in_new' },
      ]);
      if (!choice) return;
      try {
        if (choice === 'push') await push(api);
        else if (choice === 'pull') await pull(api);
        else if (choice === 'settings') await openSettings(api);
        else if (choice === 'share') await openShare(api);
        else if (choice === 'view') await openViewGist(api);
      } catch (err) {
        api.ui.dialogs.toast(`Gist ${choice} failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Gist sync',
        });
      }
    },
  });

  api.ui.registerTableButton({
    id: 'gist-sync:table',
    label: 'Gist',
    icon: GITHUB_ICON_SVG,
    tooltip: 'Gist sync for this table — push, pull, view file',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect =
        ctx.anchor?.getBoundingClientRect() ??
        new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'push', label: 'Push this table', icon: 'cloud_upload' },
        { id: 'pull', label: 'Pull this table', icon: 'cloud_download' },
        { id: 'view', label: 'View gist file', icon: 'open_in_new' },
      ]);
      if (!choice) return;
      try {
        if (choice === 'push') await pushTable(api, ctx.tableId);
        else if (choice === 'pull') await pullTable(api, ctx.tableId);
        else if (choice === 'view') await viewTableGist(api, ctx.tableId);
      } catch (err) {
        api.ui.dialogs.toast(`Gist ${choice} failed: ${(err as Error).message}`, {
          kind: 'error',
          title: 'Gist sync',
        });
      }
    },
  });
}

/**
 * `#gist=` share-link boot loader. Runs after `app:ready` (the plugin
 * lifecycle's `load()` phase). The link carries a base64'd connection string
 * in the URL hash so a workspace can be shared read/write in one click.
 */
export async function load(api: HostApi): Promise<void> {
  // Creds ride in the URL #hash (not ?query): a fragment is never sent to the
  // server, keeping the embedded token out of server logs / Referer headers.
  const raw = new URLSearchParams(location.hash.replace(/^#/, '')).get('gist');
  if (!raw) return;
  // Strip the hash immediately (before any await) so the token never lingers in
  // the address bar and a refresh won't re-trigger the import.
  history.replaceState(null, '', location.pathname + location.search);

  let connectionString: string;
  try {
    connectionString = atob(raw);
  } catch {
    return;
  }
  const creds = parseConnectionString(connectionString);
  if (!creds) {
    await api.ui.dialogs.alert('The shared gist link is invalid.', 'Gist sync');
    return;
  }
  const ok = await api.ui.dialogs.confirm(
    `Load shared workspace from gist ${creds.gistId || '(new)'} (owner: ${creds.user})?\n\nThis pulls its tables into the current workspace.`,
    'Gist sync',
  );
  if (!ok) return;
  await saveCreds(api, creds);
  await pull(api);
}

// -- Credentials --------------------------------------------------------------

async function settingKey(api: HostApi): Promise<string> {
  const wsId = api.workspaceId();
  return `${SETTING_KEY_PREFIX}${wsId ?? 'default'}`;
}

async function loadCreds(api: HostApi): Promise<GistCreds | null> {
  // Primary: the flat per-field keys the Settings dialog edits.
  const [user, gistId, token] = await Promise.all([
    api.settings.get<string>('gist-sync', 'user'),
    api.settings.get<string>('gist-sync', 'gist_id'),
    api.settings.get<string>('gist-sync', 'gist_token'),
  ]);
  if (user && token) return { user, gistId: gistId ?? '', token };

  // Legacy: the pre-Settings composite object keyed `gist:<wsId>`. Migrate it
  // forward the first time so existing users don't have to re-enter creds.
  const s = await api.store.settings.findOne(await settingKey(api));
  const v = s?.value as Partial<GistCreds> | null | undefined;
  if (v?.user && v?.token) {
    const creds = { user: v.user, gistId: v.gistId ?? '', token: v.token };
    await saveCreds(api, creds);
    return creds;
  }
  return null;
}

async function saveCreds(api: HostApi, creds: GistCreds): Promise<void> {
  await api.settings.set('gist-sync', 'user', creds.user);
  await api.settings.set('gist-sync', 'gist_id', creds.gistId);
  await api.settings.set('gist-sync', 'gist_token', creds.token);
  // Keep the legacy composite in sync so anything still reading `gist:<wsId>`
  // (and the older share-link boot path) stays consistent.
  await api.store.settings.upsert({ key: await settingKey(api), value: creds });
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

function credsToConnectionString(c: GistCreds): string {
  return `user=${c.user};gist_id=${c.gistId};gist_token=${c.token}`;
}

async function openSettings(api: HostApi): Promise<void> {
  const current = await loadCreds(api);
  const prefill = current ? credsToConnectionString(current) : '';
  const input = await api.ui.dialogs.prompt(
    'Edit the Gist connection string:\nuser=<github-user>;gist_id=<id>;gist_token=<pat>;\n\nLeave gist_id empty to create a new gist on first Push.',
    prefill,
    'Gist settings',
  );
  if (input == null) return;
  const parsed = parseConnectionString(input);
  if (!parsed) {
    await api.ui.dialogs.alert(
      'Could not parse connection string. Make sure it contains user=… and gist_token=….',
      'Gist settings',
    );
    return;
  }
  await saveCreds(api, parsed);
  api.ui.dialogs.toast('Gist settings saved.', { kind: 'success', title: 'Gist sync' });
}

async function openShare(api: HostApi): Promise<void> {
  const creds = await loadCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert(
      'Configure a gist and Push first — there is nothing to share yet.',
      'Gist sync',
    );
    return;
  }
  // Use a URL #hash, not a ?query: the fragment is never sent to the server, so
  // the token stays out of server logs / Referer headers. Percent-encode the
  // base64 so URL-unsafe chars (+ / =) survive URLSearchParams parsing of the
  // hash (a literal '+' would otherwise decode back to a space and corrupt it).
  const base = location.origin + location.pathname;
  const link = `${base}#gist=${encodeURIComponent(btoa(credsToConnectionString(creds)))}`;
  const { GistShareDialog } = await import('../dialogs/gist-share-dialog.js');
  await GistShareDialog.open(link);
}

async function openViewGist(api: HostApi): Promise<void> {
  const creds = await loadCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert('No gist configured yet — Push first.', 'Gist sync');
    return;
  }
  window.open(`https://gist.github.com/${creds.user}/${creds.gistId}`, '_blank', 'noopener');
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
  // Also carries workspace metadata (view templates/instances + non-secret
  // settings) so a pull can restore more than just tables/rows.
  const viewTemplates = (await api.store.viewTemplates.find()).filter(
    (v) => v.workspaceId === wsId,
  );
  const viewInstances = (await api.store.viewInstances.find()).filter(
    (v) => v.workspaceId === wsId,
  );
  const settings = (await api.store.settings.find()).filter((s) => isSyncableSetting(s.key));
  files['_easydb.workspace.json'] = {
    content: JSON.stringify(
      {
        workspaceId: wsId,
        exportedAt: Date.now(),
        kind: 'easydb-workspace-v1',
        viewTemplates,
        viewInstances,
        settings,
      },
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
  const byName = new Map(existingTables.map((t) => [t.name.toLowerCase(), t]));

  const { TopProgress } = await import('../chrome/top-progress.js');
  const progress: ProgressHandle = TopProgress.begin('Pulling from gist…');

  let imported = 0;
  const failures: Array<{ file: string; error: string }> = [];
  const nameToId = new Map<string, string>();
  try {
    for (const [i, [name, file]] of tableFiles.entries()) {
      try {
        const content = await fetchGistFileContent(file);
        const parsed = JSON.parse(content) as {
          name: string;
          title?: string;
          columns: Table['columns'];
          rows: Array<Row['data']>;
        };
        if (!parsed.name || !Array.isArray(parsed.columns)) {
          throw new Error('unexpected file shape (missing name/columns)');
        }

        let table: Table;
        const existing = byName.get(parsed.name.toLowerCase());
        if (existing) {
          table = await api.store.tables.patch(existing.id, {
            title: parsed.title,
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
            title: parsed.title,
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

        nameToId.set(parsed.name, table.id);
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

  let importedViews = 0;
  let metadataWarning = '';
  const markerFile = gist.files['_easydb.workspace.json'];
  if (markerFile) {
    try {
      const markerContent = await fetchGistFileContent(markerFile);
      const parsedMarker = JSON.parse(markerContent) as {
        workspaceId?: string;
        viewTemplates?: ViewTemplate[];
        viewInstances?: ViewInstance[];
        settings?: Setting[];
      };
      const markerViewTemplates = parsedMarker.viewTemplates ?? [];
      const markerViewInstances = parsedMarker.viewInstances ?? [];
      const markerSettings = parsedMarker.settings ?? [];

      for (const vt of markerViewTemplates) {
        await api.store.viewTemplates.upsert({ ...vt, workspaceId: wsId });
      }

      for (const inst of markerViewInstances) {
        let tableId: string | undefined;
        if (inst.tableName) {
          tableId = nameToId.get(inst.tableName) ?? byName.get(inst.tableName)?.id;
        }
        tableId ??= inst.tableId;
        if (!tableId) continue;
        await api.store.viewInstances.upsert({ ...inst, workspaceId: wsId, tableId });
        importedViews++;
      }

      for (const s of markerSettings) {
        if (!isSyncableSetting(s.key)) continue;
        await api.store.settings.upsert(s);
      }
    } catch (err) {
      metadataWarning = `Workspace metadata import failed: ${(err as Error).message}`;
    }
  }

  if (failures.length > 0) {
    const list = failures.map((f) => `• ${f.file}: ${f.error}`).join('\n');
    api.ui.dialogs.toast(
      `Pulled ${imported} of ${tableFiles.length} tables. ${failures.length} failed:\n${list}${
        metadataWarning ? `\n${metadataWarning}` : ''
      }`,
      { kind: 'warning', title: 'Gist sync' },
    );
  } else {
    const viewsSuffix = importedViews > 0 ? ` (+${importedViews} views)` : '';
    api.ui.dialogs.toast(
      `Pulled ${imported} table${imported === 1 ? '' : 's'} from gist ${creds.gistId}.${viewsSuffix}`,
      { kind: 'success', title: 'Gist sync' },
    );
    if (metadataWarning) {
      api.ui.dialogs.toast(metadataWarning, { kind: 'warning', title: 'Gist sync' });
    }
  }
}

// -- Per-table push/pull/view --------------------------------------------------

async function pushTable(api: HostApi, tableId: string): Promise<void> {
  const creds = await ensureCreds(api);
  if (!creds) return;
  if (!creds.gistId) {
    await api.ui.dialogs.alert(
      'No gist yet — use the main Gist button to Push the whole workspace first.',
      'Gist sync',
    );
    return;
  }
  const table = await api.store.tables.findOne(tableId);
  if (!table) return;
  const rows = await api.store.rows(tableId).find();
  const content = JSON.stringify(tableToFile(table, rows), null, 2);
  const files = { [`${slug(table.name)}.table.json`]: { content } };
  const res = await fetch(`https://api.github.com/gists/${creds.gistId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(await readError(res));
  api.ui.dialogs.toast(`Pushed "${table.name}" to gist.`, { kind: 'success', title: 'Gist sync' });
}

async function pullTable(api: HostApi, tableId: string): Promise<void> {
  const creds = await loadCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert('No gist configured — Push first.', 'Gist sync');
    return;
  }
  const table = await api.store.tables.findOne(tableId);
  if (!table) return;
  const filename = `${slug(table.name)}.table.json`;
  const res = await fetch(`https://api.github.com/gists/${creds.gistId}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(await readError(res));
  const gist = (await res.json()) as {
    files: Record<string, { content: string; truncated?: boolean; raw_url?: string }>;
  };
  const file = gist.files[filename];
  if (!file) {
    await api.ui.dialogs.alert(`No file "${filename}" in the gist for this table.`, 'Gist sync');
    return;
  }
  const content = await fetchGistFileContent(file);
  const parsed = JSON.parse(content) as {
    name: string;
    title?: string;
    columns: Table['columns'];
    rows: Array<Row['data']>;
  };
  if (!parsed.name || !Array.isArray(parsed.columns)) {
    throw new Error('unexpected file shape (missing name/columns)');
  }
  await api.store.tables.patch(tableId, {
    title: parsed.title,
    columns: parsed.columns,
    updatedAt: Date.now(),
  });
  const rowColl = api.store.rows(tableId);
  const oldRows = await rowColl.find();
  await rowColl.bulkRemove(oldRows.map((r) => r.id));
  const docs = (parsed.rows ?? []).map((data) => ({
    id: cryptoUUID(),
    tableId,
    data,
    updatedAt: Date.now(),
  }));
  await rowColl.bulkInsert(docs);
  api.ui.dialogs.toast(`Pulled "${table.name}" from gist.`, { kind: 'success', title: 'Gist sync' });
}

async function viewTableGist(api: HostApi, tableId: string): Promise<void> {
  const creds = await loadCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert('No gist configured — Push first.', 'Gist sync');
    return;
  }
  const table = await api.store.tables.findOne(tableId);
  if (!table) return;
  // GitHub anchors a gist file as #file-<filename with non-alphanumerics as '-'>.
  const fileAnchor = `file-${slug(table.name)}-table-json`;
  window.open(
    `https://gist.github.com/${creds.user}/${creds.gistId}#${fileAnchor}`,
    '_blank',
    'noopener',
  );
}

// -- helpers ------------------------------------------------------------------

function tableToFile(t: Table, rows: Row[]) {
  // Project each row onto the table's CURRENT columns — exactly like CSV export
  // and the data-table do (`r.data[c.field]`). Deleting a column removes it from
  // `t.columns` but does NOT purge its (potentially large) value from each row's
  // `data` blob (see new-table-dialog: "row data isn't migrated"). Dumping raw
  // `r.data` would therefore sync — and size-count — long-deleted columns, which
  // is why a 2 MB table (per its CSV) was warning as 32 MB on push.
  const fields = t.columns.map((c) => c.field);
  return {
    name: t.name,
    title: t.title,
    columns: t.columns,
    rows: rows.map((r) => {
      const projected: Record<string, unknown> = {};
      for (const f of fields) projected[f] = r.data[f];
      return projected;
    }),
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
