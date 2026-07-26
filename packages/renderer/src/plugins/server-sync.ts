import type { HostApi, PluginModule } from '@easydb/shared';
import { serializeWorkspace } from './dump-export.js';
import {
  loadEtag,
  loadServerUrl,
  replaceWorkspace,
  saveEtag,
  saveServerUrl,
  stripEtag,
} from './server-sync-core.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'server-sync',
  name: 'Server Sync',
  version: '0.1.0',
  description: 'Push and pull the current workspace to an easyDBAccess Hono backend.',
  author: 'easyDBAccess built-ins',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/server-sync.ts',
};

export function init(api: HostApi): void {
  // Settings tab. `url` maps to the existing `server-sync:url` key, so the
  // dialog edits the same value the manual Push/Pull and auto-sync already read.
  api.ui.registerSettings('server-sync', 'Server Sync', [
    {
      key: 'url',
      label: 'Server URL',
      type: 'string',
      scope: 'workspace',
      description: 'Base URL of the sync server, e.g. http://localhost:3000',
    },
  ]);

  api.ui.registerFooterButton({
    id: 'server-sync:menu',
    label: 'Sync',
    icon: 'cloud_sync',
    tooltip: 'Server sync — push or pull this workspace',
    onClick: async (api, ctx) => {
      const { AnchoredMenu } = await import('../chrome/anchored-menu.js');
      const rect =
        ctx?.anchor?.getBoundingClientRect() ??
        new DOMRect(16, window.innerHeight - 48, 0, 0);
      const choice = await AnchoredMenu.open(rect, [
        { id: 'push', label: 'Push (↑)', icon: 'cloud_upload' },
        { id: 'pull', label: 'Pull (↓)', icon: 'cloud_download' },
      ]);
      if (!choice) return;
      try {
        if (choice === 'push') await push(api);
        else if (choice === 'pull') await pull(api);
      } catch (err) {
        api.ui.dialogs.toast(
          `${choice === 'push' ? 'Push' : 'Pull'} failed: ${(err as Error).message}`,
          { kind: 'error', title: 'Server sync' },
        );
      }
    },
  });
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
    api.ui.dialogs.toast(`Workspace "${wsId}" doesn't exist on the server yet. Push first.`, {
      kind: 'warning',
      title: 'Server sync',
    });
    return;
  }
  if (!res.ok) throw new Error(await readError(res));

  const etag = stripEtag(res.headers.get('ETag'));
  const dump = await res.json();
  const imported = await replaceWorkspace(api, wsId, dump);

  if (etag) await saveEtag(api, wsId, etag);
  api.ui.dialogs.toast(`Pulled ${imported} table${imported === 1 ? '' : 's'} from ${url}.`, {
    kind: 'success',
    title: 'Server sync',
  });
}

/**
 * Reads the configured server URL or prompts the user for one. Lives here
 * rather than in -core because it uses api.ui.dialogs — auto-sync doesn't
 * need this (it stays silent when no URL is configured).
 */
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

async function readError(res: Response): Promise<string> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  return `${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`;
}
