import type { HostApi, PluginModule } from '@easydb/shared';
import { COMMANDLET_HELP_URL } from '../dialogs/commandlet-dialog.js';
import { tableIdAtNode } from '../window-mgr/table-window-manager.js';
import { whenWindowsReady } from '../window-mgr/windows-ready.js';
import { CommandletError, looksLikeCommandlet } from './commandlet-lang.js';
import { checkCommandletString, runCommandletString, type CommandletContext } from './commandlet-run.js';

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

/** Setting: the commandlet a plain `#anchor` is turned into. */
const DEFAULT_KEY = 'default';

export function init(api: HostApi): void {
  api.ui.registerSettings(meta.id, 'Commandlets', [
    {
      key: DEFAULT_KEY,
      label: 'Default commandlet',
      type: 'string',
      scope: 'workspace',
      description: 'Run this when the URL hash is not a commandlet itself. Blank ⇒ a plain #anchor is ignored, as before.',
      help:
        'Anchors like #Matthew carry no verb, so nothing runs unless this template says what to do with one. ' +
        '$HASH is the whole anchor text and $1…$9 are its /-separated parts, e.g. ' +
        'goto/bible?Title=$HASH&@sort=Title turns #Matthew into goto/bible?Title=Matthew&@sort=Title. ' +
        'The text is substituted after parsing, so an anchor containing & or ; cannot break the command.',
      helpUrl: COMMANDLET_HELP_URL,
      helpLinkLabel: 'Commandlets guide',
    },
  ]);

  api.ui.registerCommand({
    id: 'commandlets:run',
    title: 'Run commandlet…',
    group: 'App',
    icon: 'terminal',
    keywords: ['command', 'goto', 'action', 'link', 'url'],
    run: (a) => promptAndRun(a),
  });

  // Typing a commandlet into the palette matches no command — offer to run it
  // rather than showing an empty list. Feature-detected: the seam is an
  // optional addition to the UiRegistry contract.
  api.ui.registerCommandFallback?.((query) => {
    if (!looksLikeCommandlet(query)) return null;
    return {
      id: 'commandlets:run-this',
      title: `Run this commandlet: ${query}`,
      group: 'Commands',
      icon: 'terminal',
      run: (a) => runOrToast(a, query),
    };
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

/** The dialog, then the run. Shared by the palette entry and anything else. */
async function promptAndRun(api: HostApi, initial = ''): Promise<void> {
  const { CommandletDialog } = await import('../dialogs/commandlet-dialog.js');
  const input = await CommandletDialog.open((text) => checkCommandletString(text), initial);
  if (input === null) return;
  await runOrToast(api, input);
}

/**
 * A `#hash` naming a verb is run as-is. One that does not — `#Matthew` — is fed
 * to the "Default commandlet" setting as `$HASH`, which is what lets an ordinary
 * anchor mean something in this workspace. With no setting, a plain anchor is
 * left alone, exactly as before.
 *
 * Either way the hash is cleared first, so clicking the same link twice works
 * (an unchanged hash fires no `hashchange`).
 */
async function runHash(api: HostApi): Promise<void> {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return;

  if (looksLikeCommandlet(raw)) {
    clearHash();
    await runOrToast(api, raw);
    return;
  }

  const template = (await api.settings.get<string>(meta.id, DEFAULT_KEY))?.trim();
  if (!template) return;

  const text = decodeHash(raw);
  const parts = text.split('/');
  const vars: Record<string, string> = { HASH: text };
  parts.forEach((part, i) => {
    vars[String(i + 1)] = part;
  });

  clearHash();
  await runOrToast(api, template, { vars });
}

function clearHash(): void {
  history.replaceState(null, '', location.pathname + location.search);
}

function decodeHash(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw; // a malformed escape is still ordinary text to filter on
  }
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
    // An element may name the table it is about, whatever window it is in.
    // `viz-panel` does (`data-eda-table`): a visualization always draws exactly
    // one table, but a WINDOWED one sits in no table window, so `tableIdAtNode`
    // found nothing and a target-less `#goto?…` clicked inside it refused to run.
    if (!ctx.tableId && node instanceof HTMLElement) {
      const id = node.dataset.edaTable;
      if (id) ctx.tableId = id;
    }
    // A `<view-window>` in the path IS the current view, which is what a
    // target-less `view?…` acts on. Read off the element rather than looked up:
    // the view window carries its own instance id as a property.
    if (!ctx.viewInstanceId && node instanceof HTMLElement && node.tagName === 'VIEW-WINDOW') {
      const id = (node as HTMLElement & { viewInstanceId?: string }).viewInstanceId;
      if (id) ctx.viewInstanceId = id;
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
