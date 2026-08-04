// packages/renderer/src/plugins/connect-menu.ts
//
// easyDBAccess built-in plugin — the header "Connect" button.
//
// Connect is the counterpart to Import, and deliberately its own button, dialog
// and process: importing copies data in and you own the copy, connecting points
// a window at somebody else's live table and stores nothing. Conflating them is
// what this whole refactor is undoing — see
// `.claude/plans/2026-07-28-importer-architecture.md`.
//
// The button owns no backend knowledge. Every backend registers a
// `ConnectorSpec` (`api.ui.registerConnector`) and this lists them, so adding a
// local SQLite file or another remote database later needs no edit here.

import type { ConnectorSpec, HostApi, PluginModule } from '@easydb/shared';
import { AnchoredMenu } from '../chrome/anchored-menu.js';
import { getContext } from '../app-context.js';

const CONNECT_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4A3.1 3.1 0 0 1 17 15h-4v1.9h4a5 5 0 0 0 0-10z"/></svg>';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'connect-menu',
  name: 'Connect',
  type: 'ui',
  version: '0.1.0',
  description: 'Header Connect button listing every registered live-backend connector. Chrome only — it knows no backend.',
  author: 'Marc Cawood',
  icon: CONNECT_ICON_SVG,
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/connect-menu.ts',
};

export function init(api: HostApi): void {
  api.ui.registerHeaderButton({
    id: 'connect-menu:open',
    label: 'Connect',
    icon: CONNECT_ICON_SVG,
    tooltip: 'Connect a live table on a remote backend (rows are never stored locally)',
    onClick: (a, ctx) => openConnect(a, ctx?.anchor),
  });

  api.ui.registerCommand({
    id: 'connect-menu:open',
    title: 'Connect a live table…',
    group: 'Data',
    icon: CONNECT_ICON_SVG,
    keywords: ['datasette', 'live', 'remote', 'backend'],
    run: (a) => openConnect(a),
  });
}

/** Registered connectors, lowest `order` first. */
async function connectors(): Promise<ConnectorSpec[]> {
  const { registries } = await getContext();
  return [...registries.connectors].sort((x, y) => (x.order ?? Number.MAX_SAFE_INTEGER) - (y.order ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Pick a backend and run its connect flow.
 *
 * With exactly one connector installed a menu would be a pointless extra click,
 * so we go straight to it. The menu appears once there is a real choice.
 */
async function openConnect(api: HostApi, anchor?: HTMLElement): Promise<void> {
  const specs = await connectors();

  if (specs.length === 0) {
    await api.ui.dialogs.alert('No backends are installed to connect to. Install a connector plugin from the Plugin Manager first.', 'Connect');
    return;
  }

  let chosen: ConnectorSpec | undefined = specs[0];
  if (specs.length > 1) {
    const rect = anchor?.getBoundingClientRect();
    const id = rect
      ? await AnchoredMenu.open(
          rect,
          specs.map((s) => ({ id: s.id, label: s.label, icon: s.icon })),
        )
      : // No anchor (the command palette, say) — fall back to a modal list.
        await api.ui.dialogs.choice(
          'Which backend do you want to connect to?',
          specs.map((s) => s.label),
          'Connect',
        );
    if (!id) return; // dismissed
    chosen = rect ? specs.find((s) => s.id === id) : specs.find((s) => s.label === id);
  }
  if (!chosen) return;

  // A connector owns its own error reporting for anything it can explain (a bad
  // URL, a refused token). This catch is the backstop for what it cannot.
  try {
    await chosen.connect(api);
  } catch (err) {
    await api.ui.dialogs.alert((err as Error)?.message ?? String(err), `Connect ${chosen.label} failed`);
  }
}
