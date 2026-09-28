// packages/renderer/src/plugins/record-window.ts
//
// One record, in a window of its own.
//
// Double-click a row and the record it names pops up: the table's own record
// layout if it has one, otherwise a card of every column with every field
// editable. It is `<viz-record>` — the same element the docked pane draws, given
// one row instead of a grid's worth — so a layout written for the pane reads
// identically here and there is one renderer to keep correct, not two.
//
// **One window per ROW, not per double-click.** The panel id carries both ids,
// so double-clicking the same record twice fronts the window already open while
// a second record opens beside it. That is what makes the feature useful for
// comparing two records, and it is also the only thing stopping a fast reader
// from burying the canvas in duplicates of one row.
//
// **Transient.** No `ViewInstance` row is written, so nothing accumulates in the
// workspace and nothing comes back on reload — the same trade `openPreviewPopup`
// and `openHtmlEditor` make, and the reason the view-window reconciler leaves
// these panels alone (it only closes ids in its own map).
//
// The header carries **Edit record**, which opens the record FORM. The window
// supersedes that form on the double-click, so the form has to stay one click
// away: it is the surface that handles a record as a whole — required fields,
// a new row, the delete — and this window deliberately does not.

import type { ColumnSpec, Row, Table } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { createPanel, getPanels, type PanelShellEl } from '../window-mgr/panel-shell/panel-shell.js';
import { shellViewport } from '../window-mgr/shell-viewport.js';
import { revealPanel } from '../window-mgr/reveal.js';
import { isMobileViewport } from '../util/viewport.js';
import { popupContainer } from './html-cell-editor.js';
import { previewHeader } from './preview-popup.js';
import { keyColumnOf } from './commandlet-preview.js';
import { generatedCardHtml, recordLayoutFor } from '../views/record-html.js';
import { mayWrite, patchFor } from '../views/input-writeback.js';
import { defineVizRecord, type VizRecord, type VizRecordEditRequest } from '../viz/viz-record.js';

/** Panel id for one record. Both ids, because the window is per record. */
export function recordPanelId(tableId: string, rowId: string): string {
  return `easydb-record-${cssSafe(tableId)}-${cssSafe(rowId)}`;
}

/**
 * Ids go into a DOM `id`, and a row key can be anything a user typed.
 *
 * Mirrors `table-window-manager.ts`'s rule. Collisions between two sanitized ids
 * are possible in principle and harmless here: the worst case is that one record
 * fronts another's window, which is a stale picture the subscription below
 * corrects on its next tick.
 */
function cssSafe(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Open (or front) the window for one record.
 *
 * Fronting rather than re-opening is deliberate — see the file header. A
 * minimized window is restored and panned to, which is `revealPanel`'s job.
 */
export async function openRecordWindow(tableId: string, rowId: string): Promise<void> {
  const id = recordPanelId(tableId, rowId);
  const open = getPanels().find((p) => p.id === id);
  if (open) {
    revealPanel(open);
    return;
  }

  const ctx = await getContext();
  const table = (await ctx.store.tables.findOne(tableId)) as Table | null;
  if (!table) return;
  const row = (await ctx.store.rows(tableId).findOne(rowId)) as Row | null;
  if (!row) return;

  const columns: ColumnSpec[] = table.columns ?? [];
  const readonly = table.readonly === true;
  const layout = await layoutFor(ctx, tableId, columns, readonly);

  defineVizRecord();
  const el = document.createElement('viz-record') as VizRecord & HTMLElement;
  el.style.cssText = 'display:block;height:100%';
  el.columns = columns;
  el.readonly = readonly;
  el.currentRowId = row.id;
  el.options = { html: layout, renderers: new Map(ctx.registries.cellRenderers) };

  // `rows` is the element's whole world.
  let current: Row = row;
  el.rows = [current];

  // The pane element asks and its host writes — the same contract `viz-panel`
  // keeps, and the same rule set, so a value that cannot be typed into a cell
  // cannot be typed into this window either. `allRows` is the one record here,
  // which is honest: `unique` cannot be judged from one row and `mayWrite` says
  // so rather than pretending.
  const write = async (e: CustomEvent<VizRecordEditRequest>): Promise<void> => {
    const { rowId: edited, field, value } = e.detail;
    if (edited !== rowId || !field) return;
    const col = columns.find((c) => c.field === field);
    // Re-read the table: `readonly` can be switched on while this window sits
    // open, and the window must not be the one place that misses it.
    const fresh = (await ctx.store.tables.findOne(tableId)) as Table | null;
    const verdict = mayWrite({ rowId: edited, field, value }, col, current, {
      readonly: false,
      tableReadonly: fresh?.readonly === true,
      allRows: [current],
    });
    if (!verdict.ok) {
      await ctx.api.ui.dialogs.alert(verdict.reason, 'Edit record');
      // The control still shows what was refused. `redraw`, not
      // `requestUpdate`: nothing the element draws from has changed, so its own
      // guard would skip the draw and leave the rejected value in the box.
      el.redraw();
      return;
    }
    await ctx.store.rows(tableId).patch(edited, patchFor({ rowId: edited, field, value }, current));
  };
  el.addEventListener('viz-record-edit-request', (e: Event) => void write(e as CustomEvent<VizRecordEditRequest>));

  // Set once the panel exists — a store subscription can call back the moment it
  // is made, and this one closes the window, so it cannot be made until there is
  // a window to close.
  let unsub: (() => void) | null = null;

  const key = keyColumnOf(table);
  const keyValue = key ? String(row.data[key.field] ?? '') : '';
  const panel: PanelShellEl = createPanel({
    id,
    container: popupContainer(),
    // The same violet as a preview popup: both are the transient "look at this
    // one thing" window, and two colours would say they are different kinds.
    color: '#7c3aed',
    title: keyValue ? `${table.name} — ${keyValue}` : table.name,
    content: withHeader(
      previewHeader({
        label: table.name,
        note: keyValue || undefined,
        // The record form, still one click away — see the file header. Its label
        // follows the TABLE's flag, which is the same test the form applies to
        // itself, so the button never promises an edit the form will refuse.
        recordLabel: readonly ? 'View record' : 'Edit record',
        onEditRecord: () => void openRecordForm(tableId, rowId),
      }),
      el,
    ),
    contentSize: { w: 460, h: 420 },
    position: { centerTopOffset: 60 },
    boot: { maximized: isMobileViewport() },
    // Read-and-dismiss, like the preview popup it sits beside.
    closeOnEscape: true,
    minimizeTo: '#easydb-minimized-dock',
    viewport: shellViewport(),
    onclosed: () => unsub?.(),
  });

  // Now that there is a window: follow the record. The second job here is the
  // row VANISHING — a record deleted while its window is open has nothing left
  // to draw, and a panel showing a record that no longer exists is worse than
  // one that closed itself.
  unsub = ctx.store.rows(tableId).subscribe((all) => {
    const next = (all as Row[]).find((r) => r.id === rowId);
    if (!next) {
      panel.close();
      return;
    }
    current = next;
    el.rows = [next];
    el.requestUpdate();
  });
}

/**
 * The layout the window draws with.
 *
 * The table's own record layout where it has one, so the window and the pane
 * agree. Otherwise the generated card, EDITABLE — which is the answer for almost
 * everyone, and the reason this feature needs no setup at all: double-click a row
 * in a table nobody has configured and a usable record form appears.
 *
 * A read-only table gets the plain card instead, where each value is drawn by
 * its column's real renderer rather than sat in a disabled box.
 */
async function layoutFor(ctx: Awaited<ReturnType<typeof getContext>>, tableId: string, columns: ColumnSpec[], readonly: boolean): Promise<string> {
  const wsId = ctx.workspaceId;
  const [instances, templates] = await Promise.all([ctx.store.viewInstances.find({ workspaceId: wsId }), ctx.store.viewTemplates.find({ workspaceId: wsId })]);
  const own = recordLayoutFor(instances, templates, tableId);
  return own || generatedCardHtml(columns, { editable: !readonly });
}

/**
 * The record form, loaded on demand.
 *
 * Dynamic, for the reason `commandlet-run.ts` gives: this module is reached from
 * a document-wide double-click listener, and the form is only ever wanted after
 * somebody presses the button.
 */
async function openRecordForm(tableId: string, rowId: string): Promise<void> {
  const { openEditRecordDialog } = await import('../dialogs/new-record-dialog.js');
  await openEditRecordDialog(tableId, rowId);
}

/** Header on top, record below, and the record is what scrolls. */
function withHeader(header: HTMLElement, body: HTMLElement): HTMLElement {
  const shell = document.createElement('div');
  shell.style.cssText = 'display:flex;flex-direction:column;height:100%;box-sizing:border-box';
  body.style.flex = '1 1 auto';
  body.style.minHeight = '0';
  shell.append(header, body);
  return shell;
}
