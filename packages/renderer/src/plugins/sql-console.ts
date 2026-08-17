// packages/renderer/src/plugins/sql-console.ts
//
// The SQL console: a footer button and a palette command that open a window
// onto the workspace's own database.
//
// This is the user-facing half of `DataStore.sql`. It registers NOTHING unless
// that capability is present, because the answer to "can I run SQL here?" is a
// property of the backing store, not of the build: the desktop and a
// `.edb`-backed browser tab can, and the browser's IndexedDB path cannot. A
// button that opened a console which could only ever report "not supported"
// would be worse than no button.
//
// Reads are the default and are enforced by SQLite itself in `EdbStore.runSql`,
// not here — see the dialog's own note for why that distinction matters.

import type { HostApi, PluginModule } from '@easydb/shared';
import type { SqlConsoleDialog } from '../dialogs/sql-console-dialog.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'sql-console',
  name: 'SQL Console',
  type: 'ui',
  version: '0.1.0',
  // Deliberately not `fixed`: a SQL console is exactly the kind of thing an
  // operator may want to switch off, and nothing else depends on it.
  description: 'Run SQL against this workspace. Reads by default; writes are opt-in. Only available where the workspace is a real SQLite database.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m8 9 3 3-3 3"/><path d="M13 15h3"/><rect x="2" y="4" width="20" height="16" rx="2"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/sql-console.ts',
};

/** The dialog is mounted once, lazily, and kept — so the typed SQL survives a close. */
let el: SqlConsoleDialog | null = null;

async function openConsole(seed?: string): Promise<void> {
  if (!el) {
    // Imported here rather than at module scope so the console's Lit element and
    // its styles are not in the boot bundle for a user who never opens it.
    await import('../dialogs/sql-console-dialog.js');
    el = document.createElement('sql-console-dialog');
    document.body.appendChild(el);
  }
  await el.open(seed);
}

export function init(api: HostApi): void {
  // `store.sql` is present only when the transport offers `runSql`; see
  // `createIpcDataStore`. This is the feature detection the whole plugin hangs
  // on, and it is deliberately a capability check rather than a platform check.
  if (!api.store.sql) return;

  // The button alone. The command palette already aggregates every header and
  // footer button into its "Actions" group (`command-palette-dialog.ts`), so
  // also calling `registerCommand` would list the console twice — once as
  // "SQL", once under whatever the command was titled. Every other footer-button
  // plugin (`edb-file`, `gist-sync`, `dump-export`, `server-sync`,
  // `electron-db`) registers only the button for the same reason.
  //
  // The palette matches on label + tooltip, which is why the tooltip is worded
  // as a phrase somebody would actually type.
  api.ui.registerFooterButton({
    id: 'sql-console:open',
    label: 'SQL',
    icon: 'terminal',
    tooltip: 'Run a SQL query against this workspace',
    onClick: () => void openConsole(),
  });
}
