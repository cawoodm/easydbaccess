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
  name: 'server-sync',
  version: '0.1.0',
  description: 'Push and pull the current workspace to an easyDBAccess Hono backend.',
  author: 'easyDBAccess built-ins',
};

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
  const imported = await replaceWorkspace(api, wsId, dump);

  if (etag) await saveEtag(api, wsId, etag);
  api.ui.dialogs.toast(
    `Pulled ${imported} table${imported === 1 ? '' : 's'} from ${url}.`,
    { kind: 'success', title: 'Server sync' },
  );
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
