// packages/renderer/src/plugins/edit-record.ts
//
// Double-click a grid row, get the record form.
//
// A plugin rather than grid code, and that is the whole design: the grid edits
// in place, so a double-click inside a cell would otherwise select a word. Some
// people want that back. Switching this plugin off in the Plugin Manager
// restores it, because nothing in the core listens for a double-click on a row.
//
// The row comes from `data-row-id` on the `<tr>` and the table from the
// `<data-table>` element, both read off the event's composed path — the same
// technique `commandlets.ts` uses to find the table a clicked link was in. A
// `dblclick` is composed, so it crosses the grid's shadow boundary and reaches
// this listener on `document`.
//
// Whether the record may be WRITTEN is not decided here. `openEditRecordDialog`
// reads `Table.readonly` itself, so a read-only table opens read-only wherever
// the form was opened from.

import type { HostApi, PluginModule } from '@easydb/shared';
import { openEditRecordDialog } from '../dialogs/new-record-dialog.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'edit-record',
  name: 'Edit record on double-click',
  type: 'ui',
  version: '0.1.0',
  description: 'Double-click a row to open it in the record form. Switch off to get double-click text selection back inside cells.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4v16h16v-7"/><path d="M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/edit-record.ts',
};

export function load(_api: HostApi): void {
  document.addEventListener('dblclick', onDoubleClick);
}

function onDoubleClick(e: MouseEvent): void {
  // Leave modified double-clicks alone, and anything a control has already
  // claimed. A button or a link means what it says on the second click too.
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

  const path = e.composedPath();
  let rowId = '';
  let tableId = '';
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.tagName === 'BUTTON' || node.tagName === 'A') return;
    if (!rowId && node.tagName === 'TR') rowId = node.dataset.rowId ?? '';
    if (!tableId && node.tagName === 'DATA-TABLE') tableId = (node as HTMLElement & { tableId?: string }).tableId ?? '';
  }
  if (!rowId || !tableId) return;

  void openEditRecordDialog(tableId, rowId);
}
