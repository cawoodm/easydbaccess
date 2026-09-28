// packages/renderer/src/plugins/viz-record.ts
//
// The `record` visualization: ONE row of the grid beside it, drawn through the
// user's own HTML — or a generated card when there is none.
//
// **A visualization, not a new kind of window**, and that decision is what made
// the feature small. A record layout needs somewhere to live, something to bind
// it to a table, somewhere to draw and a way to be edited. A `ViewTemplate` with
// `kind: 'viz'` is the first, a `ViewInstance` with a `ViewDock` is the second
// and third, and `$input.FIELD` was already the fourth. Nothing in `types.ts`
// changed.
//
// `channels: []`, like `viz-custom`: the markup names the columns it reads, so a
// mapping dialog would have nothing to ask. The difference from that kind is
// singular against plural — `$COUNT` and `$SUM.amount` describe the whole set,
// `$title` and `$input.body` describe one record — which is why this one
// speaks the VIEW TEMPLATE token vocabulary. See `viz/viz-record.ts`.
//
// It also owns the row double-click, because the pane needs a selection and the
// grid has none. `plugins/edit-record.ts` claims the same gesture for the record
// FORM and stands down whenever a record pane is watching this table — see
// `table/current-row.ts`, which both read and neither imports the other through.

import type { HostApi, PluginModule } from '@easydb/shared';
import { currentRowWanted, setCurrentRow } from '../table/current-row.js';
import { provideRecordPopup } from './record-popup.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'viz-record',
  name: 'Record',
  type: 'ui',
  version: '0.1.0',
  description:
    'Show one row of a table: double-click any grid row to open that record in its own window, or dock a record pane beside the grid that follows the selection. A card of every column by default, or your own HTML. Editable with $input.field.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="11" y2="9"/><line x1="7" y1="13" x2="11" y2="13"/><line x1="7" y1="17" x2="11" y2="17"/><line x1="15" y1="9" x2="17" y2="9"/><line x1="15" y1="13" x2="17" y2="13"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/viz-record.ts',
};

export function init(api: HostApi): void {
  api.ui.registerVisualization({
    id: 'record',
    label: 'Record',
    icon: 'article',
    tag: 'viz-record',
    // Nothing to map: the markup names the columns it reads, and a token IS a
    // field name here (`views/record-html.ts`).
    channels: [],
    data: 'rows',
    // It draws its own card with its own padding, so the pane's inset would be a
    // second margin — the same reason `viz-custom` bleeds.
    bleed: true,
    options: [
      {
        key: 'html',
        label: 'Layout',
        type: 'text',
        code: 'html',
        description: 'Your markup for one record. Leave it empty for a card of every column. $field, $input.field and $raw.field are replaced.',
        help:
          'Tokens are COLUMN NAMES — $title is the `title` column of the row on screen, not a placeholder you have to map. ' +
          '$title draws it through the column’s own renderer, so a markdown column reads as prose and a link column is a link. ' +
          '$raw.title is the stored text instead. $input.title is an editable control: what you type is checked against the ' +
          'column’s rules and written to the record. $_.rowId, $_.tableId and $_.updated are the record’s own ' +
          'metadata — useful for a link back to it. Anything that is not a token is left exactly as you wrote it. ' +
          'Empty means a generated card of every column, editable, which is also what Edit starts you from.',
      },
    ],
  });
}

/**
 * Two ways in, and they do not overlap.
 *
 * **The record WINDOW** is offered to whoever owns the double-click — one record
 * in a panel of its own, which is what a table with no pane docked gets. The
 * opener is registered rather than called, because `edit-record.ts` is the
 * module with the listener and neither plugin may import the other; see
 * `plugins/record-popup.ts`.
 *
 * **The selection** is claimed here, and only where a pane is already following
 * this grid. `load`, not `init`: the listener is global and only wants to exist
 * once the app is up, which is the same choice `edit-record.ts` makes.
 *
 * The row and the table come off the event's composed path — a `dblclick` is
 * composed, so it crosses the grid's shadow boundary and reaches `document`.
 * That technique is `edit-record.ts`'s, and `commandlets.ts` uses it too.
 */
export function load(_api: HostApi): void {
  provideRecordPopup((tableId, rowId) => {
    // Loaded on demand: the window reaches the store, the panel shell and the
    // `<viz-record>` element, and none of that belongs in the module graph of a
    // document-wide double-click listener.
    void import('./record-window.js').then((m) => m.openRecordWindow(tableId, rowId));
  });
  document.addEventListener('dblclick', onDoubleClick);
}

function onDoubleClick(e: MouseEvent): void {
  // Leave modified double-clicks alone, and anything a control has already
  // claimed. A button or a link means what it says on the second click too.
  if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;

  const path = e.composedPath();
  let rowId = '';
  let tableId = '';
  let viewInstanceId = '';
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.tagName === 'BUTTON' || node.tagName === 'A') return;
    if (!rowId && node.tagName === 'TR') rowId = node.dataset.rowId ?? '';
    if (!tableId && node.tagName === 'DATA-TABLE') tableId = (node as HTMLElement & { tableId?: string }).tableId ?? '';
    // A grid inside a view window publishes under the VIEW's id, so a pane
    // docked there follows that key — the same rule `visible-rows.ts` keys on.
    if (!viewInstanceId && node.tagName === 'VIEW-WINDOW') viewInstanceId = (node as HTMLElement & { viewInstanceId?: string }).viewInstanceId ?? '';
  }
  const key = viewInstanceId || tableId;
  if (!rowId || !key) return;
  // Only when a record pane is actually following this grid. Otherwise the
  // gesture belongs to `edit-record`, which opens the record form — and this
  // check is the whole of the handover between the two.
  if (!currentRowWanted(key)) return;
  // Claim it, so `edit-record`'s listener leaves it alone whichever order the
  // two were registered in.
  e.preventDefault();
  setCurrentRow(key, rowId);
}
