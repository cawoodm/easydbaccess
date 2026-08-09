import type { HostApi, PluginModule } from '@easydb/shared';
import { builtinKey } from '../plugin-host/builtin-key.js';
import tipsData from './tips.json';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'tips',
  name: 'Tips',
  type: 'ui',
  version: '0.1.0',
  description: 'Shows one unseen tip on startup, plus a "Show tip" command. Compiled from docs/help/tips.md.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21h6"/><path d="M10 18h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.3.3.5.7.5 1.1v0h6v0c0-.4.2-.8.5-1.1A6 6 0 0 0 12 3z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/tips.ts',
};

/** Device-local list of tip ids the user has already been shown. */
const SEEN_KEY = 'seen';

interface Tip {
  id: string;
  text: string;
}

const TIPS: Tip[] = tipsData.tips;

/**
 * E2E specs boot the app on every test; a modal tip would intercept their very
 * first click. `?test=1` suppresses the tip the same way `auto-sync` suppresses
 * its timer — and `?tips=1` forces it back on for the spec that tests it.
 */
function suppressed(): boolean {
  if (typeof location === 'undefined') return true;
  const sp = new URLSearchParams(location.search);
  if (sp.get('tips') === '1') return false;
  return sp.get('test') === '1';
}

async function readSeen(api: HostApi): Promise<string[]> {
  const stored = await api.settings.get<unknown>(meta.id, SEEN_KEY);
  return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Turns this plugin off: the same `builtin:<id>` record the Plugin Manager
 * writes, so "Don't show again" is visibly the same switch the user can flip
 * back on there.
 *
 * The seen list is wiped with it, so re-enabling starts the tour again from the
 * first tip — otherwise the plugin would come back on and show nothing.
 */
async function disableSelf(api: HostApi): Promise<void> {
  const key = builtinKey(meta.id);
  const existing = await api.store.plugins.findOne(key);
  await api.store.plugins.upsert({
    ...(existing ?? { url: key, lastFetched: 0 }),
    url: key,
    enabled: false,
    lastFetched: existing?.lastFetched ?? 0,
  });
  await api.settings.set(meta.id, SEEN_KEY, [], 'user');
}

/** Opens the dialog at `startIndex` and writes back what the user saw. */
async function showFrom(api: HostApi, startIndex: number): Promise<void> {
  const seen = await readSeen(api);
  const startTip = TIPS[startIndex];
  if (!startTip) return;

  // Marked seen BEFORE the dialog opens: a reload while it is open (or a close
  // the app never hears about) must not serve the same tip forever. Tips the
  // user then browses to with ‹ › are added on close.
  await api.settings.set(meta.id, SEEN_KEY, [...new Set([...seen, startTip.id])], 'user');

  const { TipsDialog } = await import('../dialogs/tips-dialog.js');
  const result = await TipsDialog.open({ tips: TIPS, startIndex });

  if (result.dontShowAgain) {
    await disableSelf(api);
    return;
  }
  await api.settings.set(meta.id, SEEN_KEY, [...new Set([...seen, ...result.viewed])], 'user');
}

export function init(api: HostApi): void {
  api.ui.registerCommand({
    id: 'tips:show',
    title: 'Show tip',
    group: 'Help',
    icon: 'lightbulb',
    keywords: ['tip', 'hint', 'help'],
    // Unlike the startup tip this never gives up: with everything seen it
    // starts over at the first tip, which is the point of asking for one.
    run: async (a) => {
      const seen = await readSeen(a);
      const unseen = TIPS.findIndex((tip) => !seen.includes(tip.id));
      await showFrom(a, unseen === -1 ? 0 : unseen);
    },
  });
}

/**
 * Shows the first tip the user has not seen yet, once the app is ready. When
 * every tip has been seen the dialog never opens — the plugin stays enabled so
 * new tips added to `docs/help/tips.md` still surface, and the "Show tip"
 * command remains for asking on purpose.
 */
export async function load(api: HostApi): Promise<void> {
  if (suppressed()) return;

  const seen = await readSeen(api);
  const startIndex = TIPS.findIndex((tip) => !seen.includes(tip.id));
  if (startIndex === -1) return;

  await showFrom(api, startIndex);
}
