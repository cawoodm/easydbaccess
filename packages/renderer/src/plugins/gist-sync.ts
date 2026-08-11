import type { HostApi, PluginModule, Row, Setting, Table, ViewInstance, ViewTemplate } from '@easydb/shared';
import { cryptoUUID, slugTable } from '../util/ids.js';
import { withoutRawSecrets } from '../db/secret-guard.js';
// Type-only: erased at compile time, so importing this module for its type
// never pulls in `lit`/`top-progress.js` at runtime (that module registers a
// custom element on import, which would blow up under Vitest's default
// Node environment). The actual class is loaded lazily via dynamic import()
// only inside pull(), below.
import type { ProgressHandle } from '../chrome/top-progress.js';
import { tableToFile } from '../export/table-file.js';
import { restoreTemplates } from '../views/template-restore.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'gist-sync',
  name: 'Gist Sync',
  type: 'sync',
  version: '0.1.0',
  description: 'Push and pull the current workspace to a private GitHub Gist.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/gist-sync.ts',
};

interface GistCreds {
  user: string;
  gistId: string;
  token: string;
}

const SETTING_KEY_PREFIX = 'gist:';

// Every workspace setting is synced. Actual secrets now live in the device-local
// secrets store (secrets.txt) and are referenced from settings via `${...}`, so
// there is nothing sensitive left to withhold — settings that hold a raw token
// travel with the gist by the user's explicit choice. Keep gists you push
// private if any credential still lives directly in a setting value.

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
      help:
        'A classic token with the single "gist" scope is enough — nothing else is ' +
        'needed and nothing else should be granted. Give it an expiry you are ' +
        'happy with; the sync stops working when it lapses and you paste a new ' +
        'one here. Keep the value in the secrets store (General tab) and ' +
        'reference it, so it is never written into a synced setting.',
      helpUrl: 'https://github.com/settings/tokens/new?scopes=gist&description=easyDBAccess',
      helpLinkLabel: 'Create a token on GitHub',
    },
  ]);

  api.ui.registerFooterButton({
    id: 'gist-sync:menu',
    label: 'Gist',
    icon: GITHUB_ICON_SVG,
    tooltip: 'Gist sync — push, pull, share…',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('@cawoodm/lit-menu');
      const rect = ctx?.anchor?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'push', label: 'Push', icon: 'cloud_upload' },
        { id: 'pull', label: 'Pull', icon: 'cloud_download' },
        { id: 'share', label: 'Share', icon: 'share' },
        { id: 'view', label: 'View gist', icon: 'open_in_new' },
      ]);
      if (!choice) return;
      try {
        if (choice === 'push' || choice === 'pull') {
          // Second step: which slice of the workspace to sync. "Data" = the
          // per-table .table.json files; "Settings" = the workspace marker
          // (view templates/instances + synced settings).
          const scopeChoice = await AnchoredMenu.open(rect, [
            { id: 'all', label: 'Everything', icon: 'sync' },
            { id: 'data', label: 'Data only (tables + rows)', icon: 'table_rows' },
            { id: 'settings', label: 'Settings only (views + settings)', icon: 'tune' },
          ]);
          if (!scopeChoice) return;
          const scope = scopeChoice as SyncScope;
          if (choice === 'push') await push(api, scope);
          else await pull(api, scope);
        } else if (choice === 'share') await openShare(api);
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
      const { AnchoredMenu } = await import('@cawoodm/lit-menu');
      const rect = ctx.anchor?.getBoundingClientRect() ?? new DOMRect(16, window.innerHeight - 48, 0, 0);
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
  const ok = await api.ui.dialogs.confirm(`Load shared workspace from gist ${creds.gistId || '(new)'} (owner: ${creds.user})?\n\nThis pulls its tables into the current workspace.`, 'Gist sync');
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
  await api.store.settings.upsert({ name: await settingKey(api), value: creds });
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
  // Gist credentials are configured in the global Settings dialog (→ Gist Sync
  // tab) now — there is no per-plugin credentials dialog. Point the user there.
  api.ui.dialogs.toast('Add your GitHub user and token in Settings → Gist Sync, then try again.', {
    kind: 'warning',
    title: 'Gist sync',
  });
  api.ui.openSettings();
  return null;
}

function credsToConnectionString(c: GistCreds): string {
  return `user=${c.user};gist_id=${c.gistId};gist_token=${c.token}`;
}

async function openShare(api: HostApi): Promise<void> {
  const creds = await loadCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert('Configure a gist and Push first — there is nothing to share yet.', 'Gist sync');
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

/** Which slice of the workspace a push/pull touches. */
type SyncScope = 'all' | 'data' | 'settings';

/** Is this a table file THIS plugin wrote? The marker file is not one. */
function isTableFile(name: string): boolean {
  return name.endsWith('.table.json') && !name.startsWith('_easydb');
}

/**
 * The gist's table files that this push is not writing — the files of tables that
 * were deleted locally, and of any table that was RENAMED (the slug goes into the
 * file name, so a rename leaves the old name behind).
 *
 * A PATCH only touches the files it names, so without this they stay in the gist
 * for good and the next pull brings the deleted table back. Files that are not
 * ours are never listed: a gist the user pointed at may hold anything else.
 *
 * Exported for the unit tests — a real push needs the GitHub API, which the e2e
 * suite does not talk to.
 */
export function staleTableFiles(remote: Iterable<string>, pushed: Iterable<string>): string[] {
  const keep = new Set(pushed);
  return [...remote].filter((name) => isTableFile(name) && !keep.has(name)).sort();
}

async function push(api: HostApi, scope: SyncScope = 'all'): Promise<void> {
  const creds = await ensureCreds(api);
  if (!creds) return;

  const wsId = api.workspaceId();
  if (!wsId) throw new Error('no active workspace');

  const includeData = scope !== 'settings';
  const includeSettings = scope !== 'data';

  const tables = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  if (includeData && tables.length === 0) {
    await api.ui.dialogs.alert('Nothing to push: the current workspace has no tables.', 'Gist sync');
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
  if (includeData)
    for (const t of tables) {
      // Remote tables emit definition only — don't fetch their live rows to discard them.
      const rows = t.source != null ? [] : await api.store.rows(t.id).find();
      const content = JSON.stringify(tableToFile(t, rows), null, 2);
      const label = `${t.name} (${(content.length / 1_000_000).toFixed(2)} MB)`;
      if (content.length > HARD_LIMIT) oversize.push(label);
      else if (content.length > SOFT_LIMIT) large.push(label);
      files[`${slugTable(t.name)}.table.json`] = { content };
    }

  // Warn before an oversized/heavy push (a single dialog covers both tiers) so
  // the user isn't surprised by a GitHub rejection or a sluggish sync.
  // https://github.com/orgs/community/discussions/147837
  if (oversize.length > 0 || large.length > 0) {
    const parts: string[] = [];
    if (oversize.length > 0) parts.push(`Over Gist's 100 MB per-file limit — GitHub will REJECT these:\n${oversize.join('\n')}`);
    if (large.length > 0) parts.push(`Large (over 10 MB) — Gist sync will be slow and less reliable:\n${large.join('\n')}`);
    const proceed = await api.ui.dialogs.confirm(
      `${parts.join('\n\n')}\n\nTo reduce size: remove unnecessary columns, limit the number of rows, ` + `or mark the table no-persist/no-sync.\n\nPush anyway?`,
      'Gist size warning',
    );
    if (!proceed) return;
  }

  // Marker file so we can detect that a gist was produced by easyDBAccess
  // when pulling (vs. some unrelated gist the user pointed at by accident).
  // Also carries workspace metadata (view templates/instances + all settings)
  // so a pull can restore more than just tables/rows.
  if (includeSettings) {
    const viewTemplates = (await api.store.viewTemplates.find()).filter((v) => v.workspaceId === wsId);
    const viewInstances = (await api.store.viewInstances.find()).filter((v) => v.workspaceId === wsId);
    // Name + value only: the physical key and workspaceId are this device's, and
    // the pulling side re-derives both for ITS workspace (see settingsView).
    const all = (await api.store.settings.find()).map((s) => ({ name: s.name, value: s.value }));
    // A credential setting may only leave this device as a `${secret:name}`
    // reference. Anything holding the value itself stays behind, whatever put it
    // there — see db/secret-guard.ts. This is the last gate before the network.
    const { kept: settings, withheld } = withoutRawSecrets(all);
    if (withheld.length > 0) {
      api.ui.dialogs.toast(
        `Not pushed: ${withheld.join(', ')} — a secret is stored as its own value. ` + `Move it into the secrets store (Settings → General) and reference it with ` + `\${secret:name}.`,
        { kind: 'warning', title: 'Gist sync' },
      );
    }
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
  }

  // `null` is how the API deletes a gist file. Only a data push prunes: a
  // settings-only push says nothing about which tables exist.
  const body: Record<string, { content: string } | null> = { ...files };
  let removed: string[] = [];
  if (includeData && creds.gistId) {
    removed = await confirmStaleRemoval(api, creds, Object.keys(files));
    for (const name of removed) body[name] = null;
  }

  let updated: { id: string; html_url?: string };
  if (creds.gistId) {
    const res = await fetch(`https://api.github.com/gists/${creds.gistId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${creds.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: body, description: `easyDBAccess workspace: ${wsId}` }),
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
    // Only the id is new. Writing the whole credential set back would push the
    // RESOLVED token into the setting that holds the reference (settings.set
    // refuses that now, but there is no reason to ask).
    creds.gistId = updated.id;
    await api.settings.set('gist-sync', 'gist_id', updated.id);
  }

  const url = updated.html_url ?? `https://gist.github.com/${creds.user}/${updated.id}`;
  const what = scope === 'settings' ? 'settings' : scope === 'data' ? `${tables.length} table${tables.length === 1 ? '' : 's'} (data only)` : `${tables.length} table${tables.length === 1 ? '' : 's'}`;
  const alsoRemoved = removed.length > 0 ? `  Removed ${removed.length} file${removed.length === 1 ? '' : 's'}.` : '';
  api.ui.dialogs.toast(`Pushed ${what}.${alsoRemoved}  ${url}`, {
    kind: 'success',
    title: 'Gist sync',
  });
}

// -- Pull ---------------------------------------------------------------------

async function pull(api: HostApi, scope: SyncScope = 'all'): Promise<void> {
  const includeData = scope !== 'settings';
  const includeSettings = scope !== 'data';
  const creds = await ensureCreds(api);
  if (!creds || !creds.gistId) {
    await api.ui.dialogs.alert('No gist id configured for this workspace. Push first or set it via the connection string.', 'Gist sync');
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

  const tableFiles = Object.entries(gist.files).filter(([name]) => name.endsWith('.table.json') && !name.startsWith('_easydb'));
  if (includeData && tableFiles.length === 0) {
    await api.ui.dialogs.alert('Gist contains no .table.json files.', 'Gist sync');
    return;
  }

  // Index existing tables by name so we upsert instead of duplicating (and so
  // a settings-only pull can re-point view instances at already-local tables).
  const existingTables = (await api.store.tables.find()).filter((t) => t.workspaceId === wsId);
  const byName = new Map(existingTables.map((t) => [t.name.toLowerCase(), t]));

  let imported = 0;
  const failures: Array<{ file: string; error: string }> = [];
  const nameToId = new Map<string, string>();
  if (includeData) {
    const { TopProgress } = await import('../chrome/top-progress.js');
    const progress: ProgressHandle = TopProgress.begin('Pulling from gist…');
    try {
      for (const [i, [name, file]] of tableFiles.entries()) {
        try {
          const content = await fetchGistFileContent(file);
          const parsed = JSON.parse(content) as {
            name: string;
            title?: string;
            columns: Table['columns'];
            rows: Array<Row['data']>;
          } & TableFileMeta;
          if (!parsed.name || !Array.isArray(parsed.columns)) {
            throw new Error('unexpected file shape (missing name/columns)');
          }

          let table: Table;
          const existing = byName.get(parsed.name.toLowerCase());
          if (existing) {
            table = await api.store.tables.patch(existing.id, {
              title: parsed.title,
              columns: parsed.columns,
              ...syncedTableFields(parsed),
              updatedAt: Date.now(),
            });
            // Wipe existing rows for clean reimport (simplest correct behavior) —
            // but only for LOCAL tables. A remote table's rows are re-fetched live
            // through its routed collection, so we must never touch them here.
            if (table.source == null) {
              const rowColl = api.store.rows(existing.id);
              const oldRows = await rowColl.find();
              await rowColl.bulkRemove(oldRows.map((r) => r.id));
            }
          } else {
            table = await api.store.tables.insert({
              id: cryptoUUID(),
              workspaceId: wsId,
              name: parsed.name,
              title: parsed.title,
              code: slugTable(parsed.name),
              columns: parsed.columns,
              view: parsed.view ?? 'table',
              ...syncedTableFields(parsed),
              updatedAt: Date.now(),
            });
          }

          // Remote tables get no local rows — the definition alone reconnects
          // them to their backend, which serves the live data.
          if (table.source == null) {
            const docs = (parsed.rows ?? []).map((data) => ({
              id: cryptoUUID(),
              tableId: table.id,
              data,
              updatedAt: Date.now(),
            }));
            await api.store.rows(table.id).bulkInsert(docs);
          }

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
  }

  let importedViews = 0;
  let metadataWarning = '';
  // Ids of the view instances this pull carried — null until we know the gist
  // has a marker file, so a gist without one never looks like "all views gone".
  let pulledViewIds: Set<string> | null = null;
  const markerFile = includeSettings ? gist.files['_easydb.workspace.json'] : undefined;
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
      pulledViewIds = new Set(markerViewInstances.map((v) => v.id));

      const templateIds = await restoreTemplates(api.store.viewTemplates, wsId, markerViewTemplates);

      for (const inst of markerViewInstances) {
        let tableId: string | undefined;
        if (inst.tableName) {
          tableId = nameToId.get(inst.tableName) ?? byName.get(inst.tableName)?.id;
        }
        tableId ??= inst.tableId;
        if (!tableId) continue;
        const templateId = templateIds.get(inst.templateId) ?? inst.templateId;
        await api.store.viewInstances.upsert({ ...inst, workspaceId: wsId, tableId, templateId });
        importedViews++;
      }

      for (const s of markerSettings) {
        await api.store.settings.upsert(s);
      }
    } catch (err) {
      metadataWarning = `Workspace metadata import failed: ${(err as Error).message}`;
    }
  }

  if (failures.length > 0) {
    const list = failures.map((f) => `• ${f.file}: ${f.error}`).join('\n');
    api.ui.dialogs.toast(`Pulled ${imported} of ${tableFiles.length} tables. ${failures.length} failed:\n${list}${metadataWarning ? `\n${metadataWarning}` : ''}`, {
      kind: 'warning',
      title: 'Gist sync',
    });
  } else {
    const viewsSuffix = importedViews > 0 ? ` (+${importedViews} views)` : '';
    const msg = scope === 'settings' ? `Pulled settings${viewsSuffix}.` : `Pulled ${imported} table${imported === 1 ? '' : 's'}.${viewsSuffix}`;
    api.ui.dialogs.toast(msg, { kind: 'success', title: 'Gist sync' });
    if (metadataWarning) {
      api.ui.dialogs.toast(metadataWarning, { kind: 'warning', title: 'Gist sync' });
    }
  }

  // A pull upserts, so anything local that the gist does not carry stays behind —
  // either local-only work or something a peer deleted. Offer to remove it. Only
  // after a clean pull: a table whose file failed to parse is missing from
  // `nameToId` although the gist has it, and must not be offered for deletion.
  if (failures.length === 0) {
    await offerPrune(api, wsId, {
      tableNames: includeData ? new Set([...nameToId.keys()].map((n) => n.toLowerCase())) : null,
      viewInstanceIds: pulledViewIds,
    });
  }

  // The incremental inserts above opened panels in file order, not saved-z order
  // (liveQuery fires per write, so the window manager's z-sort never sees them
  // as a batch). Ask the window manager to restack the panels by saved z.
  document.dispatchEvent(new CustomEvent('easydb:restack-windows'));
}

/**
 * Which of the gist's table files this push should DELETE, after asking.
 *
 * It asks for the same reason the pull side asks before deleting local tables
 * (`offerPrune`): a push from a device that has not pulled lately would otherwise
 * remove a table another device added. Answering no keeps every remote file, so
 * the push is exactly what it always was.
 *
 * A failed listing is not a failed push — the gist is left as it is and the
 * tables being pushed still go up.
 */
async function confirmStaleRemoval(api: HostApi, creds: GistCreds, pushed: string[]): Promise<string[]> {
  let remote: string[];
  try {
    const res = await fetch(`https://api.github.com/gists/${creds.gistId}`, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return [];
    const gist = (await res.json()) as { files?: Record<string, unknown> };
    remote = Object.keys(gist.files ?? {});
  } catch {
    return [];
  }
  const stale = staleTableFiles(remote, pushed);
  if (stale.length === 0) return [];
  const yes = await api.ui.dialogs.confirm(
    `The gist has these table files that this workspace no longer has:\n\n${nameList(stale)}\n\n` +
      `Delete them from the gist, so it matches this workspace? Keep them if another ` +
      `device pushed them and you have not pulled yet.`,
    'Delete table files missing from this workspace?',
  );
  return yes ? stale : [];
}

/** At most `max` names, with a "+n more" tail so a long list stays readable. */
function nameList(names: string[], max = 8): string {
  const shown = names.slice(0, max).map((n) => `• ${n}`);
  const rest = names.length - shown.length;
  return [...shown, ...(rest > 0 ? [`• …and ${rest} more`] : [])].join('\n');
}

/**
 * Offer to delete the workspace objects a pull did not carry. A `null` set means
 * the pull carried no objects of that kind (a settings-only pull has no tables,
 * a gist without the workspace marker file has no views), so those local objects
 * are left alone rather than read as deleted upstream.
 *
 * Exported for the unit tests (like `fetchGistFileContent`) — a real pull needs
 * the GitHub API, which the e2e suite does not talk to.
 */
export async function offerPrune(api: HostApi, wsId: string, pulled: { tableNames: Set<string> | null; viewInstanceIds: Set<string> | null }): Promise<void> {
  const extraTables = pulled.tableNames ? (await api.store.tables.find()).filter((t) => t.workspaceId === wsId && !pulled.tableNames!.has(t.name.toLowerCase())) : [];
  const extraViews = pulled.viewInstanceIds ? (await api.store.viewInstances.find()).filter((v) => v.workspaceId === wsId && !pulled.viewInstanceIds!.has(v.id)) : [];
  if (extraTables.length === 0 && extraViews.length === 0) return;

  const parts: string[] = [];
  if (extraTables.length > 0) {
    parts.push(`${extraTables.length} table${extraTables.length === 1 ? '' : 's'}:\n` + nameList(extraTables.map((t) => t.name)));
  }
  if (extraViews.length > 0) {
    parts.push(`${extraViews.length} view${extraViews.length === 1 ? '' : 's'}:\n` + nameList(extraViews.map((v) => v.name)));
  }
  const yes = await api.ui.dialogs.confirm(
    `The gist does not have these local objects:\n\n${parts.join('\n\n')}\n\n` +
      `Delete them, so this workspace matches the gist? A table goes with its rows. ` +
      `Keep them if this is local work you have not pushed yet.`,
    'Delete objects missing from the pull?',
  );
  if (!yes) return;

  for (const v of extraViews) await api.store.viewInstances.remove(v.id);
  // Same cascade the trash button uses: local rows go, a live table's remote
  // data stays and only the local connection is dropped. Imported lazily for the
  // same reason as top-progress above — the module registers custom elements, so
  // a static import would break the unit tests' Node environment.
  const { deleteTable } = await import('../window-mgr/table-window-manager.js');
  for (const t of extraTables) await deleteTable(t.id);
  api.ui.dialogs.toast(`Deleted ${extraTables.length} table${extraTables.length === 1 ? '' : 's'} and ` + `${extraViews.length} view${extraViews.length === 1 ? '' : 's'}.`, {
    kind: 'success',
    title: 'Gist sync',
  });
}

// -- Per-table push/pull/view --------------------------------------------------

async function pushTable(api: HostApi, tableId: string): Promise<void> {
  const creds = await ensureCreds(api);
  if (!creds) return;
  if (!creds.gistId) {
    await api.ui.dialogs.alert('No gist yet — use the main Gist button to Push the whole workspace first.', 'Gist sync');
    return;
  }
  const table = await api.store.tables.findOne(tableId);
  if (!table) return;
  // Remote tables push their definition only; their rows live in the backend.
  const rows = table.source != null ? [] : await api.store.rows(tableId).find();
  const content = JSON.stringify(tableToFile(table, rows), null, 2);
  const files = { [`${slugTable(table.name)}.table.json`]: { content } };
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
  const filename = `${slugTable(table.name)}.table.json`;
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
  } & TableFileMeta;
  if (!parsed.name || !Array.isArray(parsed.columns)) {
    throw new Error('unexpected file shape (missing name/columns)');
  }
  const patched = await api.store.tables.patch(tableId, {
    title: parsed.title,
    columns: parsed.columns,
    ...syncedTableFields(parsed),
    updatedAt: Date.now(),
  });
  // Local tables replace their rows from the file; a remote table keeps its
  // live-fetched rows — its restored definition reconnects it to the backend.
  if (patched.source == null) {
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
  }
  api.ui.dialogs.toast(`Pulled "${table.name}" from gist.`, {
    kind: 'success',
    title: 'Gist sync',
  });
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
  const fileAnchor = `file-${slugTable(table.name)}-table-json`;
  window.open(`https://gist.github.com/${creds.user}/${creds.gistId}#${fileAnchor}`, '_blank', 'noopener');
}

// -- helpers ------------------------------------------------------------------
//
// `tableToFile` (the `.table.json` shape) now lives in `../export/table-file.js`
// — it's shared with the per-table export menu's JSON option (dump-export.ts).

/** The per-table display/query fields a gist file may carry (beyond name/columns/rows). */
type TableFileMeta = {
  view?: string;
  windowGeometry?: Table['windowGeometry'];
  sortColumn?: string;
  sortAsc?: boolean;
  filters?: Table['filters'];
  labelColumn?: string;
  deletedColumns?: string[];
  info?: Table['info'];
  source?: Table['source'];
  origin?: Table['origin'];
};

/**
 * Extract the display/query fields present in a parsed gist file into a table
 * patch. Only fields the file actually carries are returned, so pulling an
 * older gist never clears newer local state (and `everything should be synced`
 * stays additive as new fields are added to the file above).
 */
function syncedTableFields(p: TableFileMeta): Partial<Table> {
  const out: Partial<Table> = {};
  if (p.view !== undefined) out.view = p.view;
  if (p.windowGeometry) out.windowGeometry = p.windowGeometry;
  if (p.sortColumn !== undefined) out.sortColumn = p.sortColumn;
  if (p.sortAsc !== undefined) out.sortAsc = p.sortAsc;
  if (p.filters !== undefined) out.filters = p.filters;
  if (p.labelColumn !== undefined) out.labelColumn = p.labelColumn;
  if (p.deletedColumns !== undefined) out.deletedColumns = p.deletedColumns;
  if (p.info !== undefined) out.info = p.info;
  // Restore routing so a remote table reconnects to its backend on pull.
  if (p.source !== undefined) out.source = p.source;
  if (p.origin !== undefined) out.origin = p.origin;
  return out;
}

/**
 * Resolve a gist file's FULL content. GitHub truncates the inline `content` of
 * large gist files (setting `truncated: true` + a `raw_url` to the full body);
 * blindly parsing the truncated string is what caused "Pull failed: Expected
 * double-quoted property name…". When truncated, fetch the raw_url — a secret
 * gist's raw_url is link-accessible and served with `Access-Control-Allow-Origin: *`,
 * so a plain GET (no auth header → no CORS preflight) works from the browser.
 */
export async function fetchGistFileContent(file: { content: string; truncated?: boolean; raw_url?: string }, doFetch: (url: string) => Promise<Response> = (u) => fetch(u)): Promise<string> {
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
