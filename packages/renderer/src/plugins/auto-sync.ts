import type { HostApi, PluginModule } from '@easydb/shared';
import { serializeWorkspace } from './dump-export.js';
import {
  canonicalize,
  loadEtag,
  loadServerUrl,
  replaceWorkspace,
  saveEtag,
  stripEtag,
} from './server-sync-core.js';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'auto-sync',
  version: '0.1.0',
  description:
    'Pushes the workspace to the server every minute; prompts to pull when the server changes.',
  author: 'easyDBAccess built-ins',
  optional: true,
};

/** Interval between ticks. Real product value — tests drive tick() directly. */
const INTERVAL_MS = 60_000;

let intervalId: ReturnType<typeof setInterval> | null = null;
let prompting = false;
const dismissedEtag = new Map<string, string>();

/**
 * Runs after `app:ready`. We schedule the first tick INTERVAL_MS in the
 * future rather than firing immediately so boot stays quiet — the user
 * doesn't see a "server has new data" prompt before the UI has settled.
 *
 * Note: workspace switches reload the page (workspace-selector → location
 * .assign), which tears down this interval automatically. No dispose hook
 * needed.
 */
export function load(api: HostApi): void {
  if (intervalId !== null) return;
  // E2E tests drive tick() manually via window.__autoSyncTick — let them
  // own the scheduling so a stray timer doesn't fire a confirm() mid-test.
  if (
    typeof location !== 'undefined' &&
    new URLSearchParams(location.search).get('test') === '1'
  ) {
    return;
  }
  intervalId = setInterval(() => {
    void tick(api);
  }, INTERVAL_MS);
}

/**
 * One sync cycle. Exported so e2e tests can drive it without waiting a full
 * minute. Idempotent and re-entrancy-safe: ticks while a prompt is open are
 * dropped.
 */
export async function tick(api: HostApi): Promise<void> {
  if (prompting) return;
  const wsId = api.workspaceId();
  if (!wsId) return;
  const url = await loadServerUrl(api);
  if (!url) return;

  try {
    await syncOnce(api, url, wsId);
  } catch (err) {
    // Surface to devtools but never toast — a minute-by-minute timer that
    // pops a toast for every transient 500 would be miserable.
    // eslint-disable-next-line no-console
    console.warn('[auto-sync]', err);
  }
}

async function syncOnce(api: HostApi, url: string, wsId: string): Promise<void> {
  const localBody = await serializeWorkspace(api);
  const localEtag = await loadEtag(api, wsId);

  // Probe the server once per tick. GET also gives us the body so we can
  // tell "in sync" from "diverged" without a second round-trip.
  const probe = await fetch(`${url}/sync/${encodeURIComponent(wsId)}`);

  if (probe.status === 404) {
    // No copy on the server yet — silently seed it.
    await silentPut(api, url, wsId, localBody, null);
    return;
  }
  if (!probe.ok) return; // transient — let next tick retry

  const serverEtag = stripEtag(probe.headers.get('ETag'));
  const serverBody = await probe.text();

  if (canonicalize(localBody) === canonicalize(serverBody)) {
    // In sync. Refresh our stored etag if it's stale (someone else may have
    // pushed an identical body and our stored etag is from before that).
    if (serverEtag && serverEtag !== localEtag) {
      await saveEtag(api, wsId, serverEtag);
    }
    return;
  }

  // Diverged.
  if (serverEtag && serverEtag === localEtag) {
    // Server matches what we last saw — local has unsaved changes. Push.
    await silentPut(api, url, wsId, localBody, localEtag);
    return;
  }

  // Server is on a different etag than we last saw → genuine remote change.
  // The dismissed-etag short-circuit suppresses re-prompting until the
  // server changes AGAIN past whatever the user already said no to.
  if (serverEtag && dismissedEtag.get(wsId) === serverEtag) return;

  prompting = true;
  try {
    const yes = await api.ui.dialogs.confirm(
      `The server has new data for "${wsId}". Pull and replace your local copy?`,
      'auto-sync',
    );
    if (yes) {
      const dump = JSON.parse(serverBody) as unknown;
      const imported = await replaceWorkspace(api, wsId, dump);
      if (serverEtag) await saveEtag(api, wsId, serverEtag);
      dismissedEtag.delete(wsId);
      api.ui.dialogs.toast(
        `Pulled ${imported} table${imported === 1 ? '' : 's'} from the server.`,
        { kind: 'success', title: 'auto-sync' },
      );
    } else if (serverEtag) {
      dismissedEtag.set(wsId, serverEtag);
    }
  } finally {
    prompting = false;
  }
}

async function silentPut(
  api: HostApi,
  url: string,
  wsId: string,
  body: string,
  ifMatch: string | null,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
  const res = await fetch(`${url}/sync/${encodeURIComponent(wsId)}`, {
    method: 'PUT',
    headers,
    body,
  });
  if (res.ok) {
    const newEtag = stripEtag(res.headers.get('ETag'));
    if (newEtag) await saveEtag(api, wsId, newEtag);
    return;
  }
  // 412 (race between our GET and PUT) — adopt server's currentEtag so the
  // next tick re-evaluates with fresh state. Auto-sync does not prompt on
  // push conflicts; that's the manual server-sync's job.
  if (res.status === 412) {
    const data = (await res.json().catch(() => ({}))) as { currentEtag?: string };
    if (data.currentEtag) await saveEtag(api, wsId, data.currentEtag);
  }
}
