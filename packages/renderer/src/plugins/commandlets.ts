import type { HostApi, PluginModule } from '@easydb/shared';
import { tableIdAtNode } from '../window-mgr/table-window-manager.js';
import { whenWindowsReady } from '../window-mgr/windows-ready.js';
import { CommandletError, looksLikeCommandlet } from './commandlet-lang.js';
import { runCommandletString, type CommandletContext } from './commandlet-run.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'commandlets',
  name: 'Commandlets',
  type: 'ui',
  version: '0.1.0',
  description: 'Run URL-shaped actions like goto/bible?Book=Matthew — from a link, a #hash, ?cmdlet= or the palette.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/commandlets.ts',
};

/** Boot deep link: `?cmdlet=goto/bible?Book=Matthew` (the `&` inside needs `%26`). */
const BOOT_PARAM = 'cmdlet';

export function init(api: HostApi): void {
  api.ui.registerCommand({
    id: 'commandlets:run',
    title: 'Run commandlet…',
    group: 'App',
    icon: 'terminal',
    keywords: ['command', 'goto', 'action', 'link', 'url'],
    run: async (a) => {
      const input = await a.ui.dialogs.prompt('Commandlet, e.g. goto/bible?Book=Matthew', '', 'Run commandlet');
      if (input === null || input.trim() === '') return;
      await runOrToast(a, input);
    },
  });
}

export function load(api: HostApi): void {
  // A link in a cell is intercepted BEFORE the hash changes: the click knows
  // which table, column and value it came from, and that context is exactly
  // what `$TABLE` / `$FIELD` / `$VALUE` resolve against. Going through the hash
  // would throw it away — and would do nothing at all on a second click of the
  // same link, since an unchanged hash fires no `hashchange`.
  document.addEventListener('click', (e) => void onDocumentClick(api, e), true);
  window.addEventListener('hashchange', () => void runHash(api));

  // Deliberately NOT awaited: `loadBuiltinPlugins` runs every plugin's `load()`
  // in one sequential loop, so waiting for the windows here would hold up
  // everything queued behind this plugin (the URL plugins among them) until the
  // panels are on screen.
  void whenWindowsReady().then(() => runBootCommandlets(api));
}

async function runBootCommandlets(api: HostApi): Promise<void> {
  const boot = new URLSearchParams(location.search).get(BOOT_PARAM);
  if (boot) await runOrToast(api, boot);
  await runHash(api);
}

/**
 * A `#hash` that names a verb is run and then cleared, so the same link works
 * twice. A hash that is NOT a commandlet (`#Matthew`) is left alone — that is
 * ordinary anchor text, and mapping it to an action is the user's own rule.
 */
async function runHash(api: HostApi): Promise<void> {
  const raw = location.hash.replace(/^#/, '');
  if (!raw || !looksLikeCommandlet(raw)) return;
  history.replaceState(null, '', location.pathname + location.search);
  await runOrToast(api, raw);
}

async function onDocumentClick(api: HostApi, e: MouseEvent): Promise<void> {
  // Leave modified clicks to the browser: ctrl/cmd-click means "open elsewhere",
  // and a commandlet has no elsewhere to open in.
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const path = e.composedPath();
  const anchor = path.find((n): n is HTMLAnchorElement => n instanceof HTMLAnchorElement);
  if (!anchor) return;
  const href = anchor.getAttribute('href') ?? '';
  if (!href.startsWith('#')) return;
  const text = href.slice(1);
  if (!looksLikeCommandlet(text)) return;

  e.preventDefault();
  await runOrToast(api, text, contextOf(path));
}

/** What the DOM around the click can tell us about where it came from. */
function contextOf(path: EventTarget[]): CommandletContext {
  const ctx: CommandletContext = {};
  for (const node of path) {
    if (!ctx.tableId) {
      const id = tableIdAtNode(node);
      if (id) ctx.tableId = id;
    }
    // Cell renderers are given `column` and `value` as properties, so the cell
    // element in the path carries both without the host having to look them up.
    if (ctx.field === undefined && node instanceof HTMLElement) {
      const cell = node as HTMLElement & { column?: { field?: string }; value?: unknown };
      if (cell.column?.field) {
        ctx.field = cell.column.field;
        if (cell.value != null) ctx.value = String(cell.value);
      }
    }
  }
  return ctx;
}

async function runOrToast(api: HostApi, input: string, ctx?: CommandletContext): Promise<void> {
  try {
    await runCommandletString(input, ctx ?? {});
  } catch (err) {
    const message = err instanceof CommandletError ? err.message : err instanceof Error ? err.message : String(err);
    api.ui.dialogs.toast(message, { kind: 'error', title: 'Commandlet' });
  }
}
