// packages/renderer/src/dialogs/column-preview-table.ts
//
// The live preview both column editors show: the first rows of the table, drawn
// the way the columns in front of you say they should be drawn.
//
// One element rather than one per dialog, because a preview that disagreed with
// the other preview would be worse than no preview. The table's columns editor
// and a view's own editor pass different column specs — that is the whole point
// of a view — and everything downstream of the specs is identical.
//
// It draws cells through the CELL RENDERER REGISTRY, exactly as `data-table`
// does, so a `link` column shows a link here and a `markdown` column shows
// prose. The first version of this showed every value as plain text, which made
// the renderer picker directly above it the one setting in the dialog whose
// effect the preview could not show.
//
// Nothing here writes, and it is enforced twice. Every renderer is handed
// `readonly` and no `change` listener, so one that honours the flag shows its
// display form. But a renderer is a plugin and may ignore it — `cell-link` puts
// its pencil up regardless, and a third-party one could do anything — so the
// table itself is `inert`: no clicks, no focus, no keyboard. The row grid behind
// the dialog is where data is edited; an edit made in here would bypass every
// check the dialog is about to apply, and with no change handler wired it would
// be silently thrown away.
//
// `inert` does take the table out of the accessibility tree, which is the cost.
// The heading stays outside it, and what the table shows is a picture of rows
// that the grid itself presents properly — so the trade is a picture nobody can
// break rather than a form that lies about what it will save.

import { LitElement, css, html } from 'lit';
import { html as staticHtml, unsafeStatic } from 'lit/static-html.js';
import { customElement, property, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import type { ColumnSpec, Row } from '@easydb/shared';
import { getContext } from '../app-context.js';
import { clampPreviewHeight, PREVIEW_HEIGHT_DEFAULT, previewCells, previewText, type PreviewCell } from '../table/column-preview.js';
import { readUserSetting, writeUserSetting } from '../db/user-settings.js';

/**
 * The dragged height, device-local rather than in the workspace.
 *
 * How tall a pane is on THIS screen is not something to sync to another machine,
 * and it is not part of the data — the same reasoning as the grid's own
 * device-local settings.
 */
const HEIGHT_SETTING = 'column-preview:height';

/** Why the preview has no rows — a read still running, a read that failed and a
 * genuinely empty table all used to show the same "No rows to preview". */
export type PreviewState = 'none' | 'loading' | 'ready' | 'error';

@customElement('column-preview-table')
export class ColumnPreviewTable extends LitElement {
  static override styles = css`
    /* A flex item of fixed height inside the dialog body, so the grip trades
       space with the column list above instead of making the dialog taller. */
    :host {
      display: flex;
      flex-direction: column;
      /* Sized by its content up to the dragged ceiling, and neither grown nor
         shrunk by the flex parent. So two rows of preview leave the rest of the
         dialog to the column list, a hundred rows take the whole ceiling, and
         the list — which can scroll — is what yields. Let the preview shrink
         instead and a long column list steals back the room just granted. */
      flex: none;
      min-height: 0;
    }
    /* The drag handle. Full width and its own row, because a corner-sized grip
       on a pane this wide is a target the user has to hunt for. */
    .grip {
      flex: none;
      height: 0.55rem;
      margin-top: 0.35rem;
      border-top: 1px solid #e5e7eb;
      cursor: ns-resize;
      display: flex;
      align-items: center;
      justify-content: center;
      touch-action: none;
    }
    .grip::after {
      content: '';
      width: 2.5rem;
      height: 3px;
      border-radius: 2px;
      background: #d1d5db;
    }
    .grip:hover::after,
    .grip.dragging::after {
      background: #9ca3af;
    }
    .preview {
      flex: 0 1 auto;
      min-height: 0;
      overflow: auto;
    }
    .preview h3 {
      margin: 0;
      padding: 0.35rem 0.4rem 0.4rem;
      font-size: 0.85rem;
      color: #6b7280;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    th,
    td {
      border: 1px solid #e5e7eb;
      padding: 0.2rem 0.4rem;
      text-align: left;
      vertical-align: top;
      max-width: 18rem;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* Plain text stays on one line, as a grid row does. A RENDERED cell may be
       an element of its own height (prose, an image), so it is capped instead —
       one tall cell would otherwise set the height of its whole row. */
    td.text {
      white-space: nowrap;
    }
    td.rendered {
      max-height: 4.5rem;
    }
    th {
      background: #f9fafb;
      position: sticky;
      top: 0;
      z-index: 1;
    }
    td.violation {
      background: #fee2e2;
      color: #991b1b;
    }
    .script-err {
      color: #b45309;
      font-style: italic;
      white-space: nowrap;
    }
    .empty {
      padding: 0.75rem 0.4rem;
      color: #9ca3af;
      font-style: italic;
    }
  `;

  /** The columns to show, already filtered and ordered by the caller. */
  @property({ attribute: false }) columns: readonly ColumnSpec[] = [];
  /** The rows to show, already re-keyed for any pending rename. */
  @property({ attribute: false }) rows: readonly Row[] = [];
  @property({ attribute: false }) state: PreviewState = 'none';
  /** Why the read failed. Shown with the failure — a reason the user can act on. */
  @property({ attribute: false }) error: string | null = null;
  /** Optional reassurance after a failed read, e.g. that the settings still save. */
  @property({ attribute: false }) note = '';

  /** Renderer name → custom element tag, snapshotted as `data-table` does it. */
  @state() private cellRenderers: Map<string, string> = new Map();
  /** The dragged height in px. Read from the device once, per session. */
  @state() private height = readHeight();
  @state() private dragging = false;
  private rendererSubUnsub?: (() => void) | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    void this.adoptRenderers();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.rendererSubUnsub?.();
    this.rendererSubUnsub = undefined;
  }

  /** Take the registry, and take it again if a plugin registers while we are open. */
  private async adoptRenderers(): Promise<void> {
    const ctx = await getContext();
    this.cellRenderers = new Map(ctx.registries.cellRenderers);
    this.rendererSubUnsub?.();
    this.rendererSubUnsub = ctx.events.on('app:ready', () => {
      this.cellRenderers = new Map(ctx.registries.cellRenderers);
    });
  }

  /**
   * Start a resize.
   *
   * Pointer capture rather than window listeners: the pointer leaves this
   * 9-pixel bar on the first move, and a capture keeps the events coming to the
   * element that started the drag — including over the renderers' own elements,
   * which would otherwise swallow them.
   */
  private startDrag(e: PointerEvent): void {
    const grip = e.currentTarget as HTMLElement;
    const startY = e.clientY;
    const startHeight = this.height;
    grip.setPointerCapture(e.pointerId);
    this.dragging = true;
    // Up is bigger: the grip is the pane's top edge, so it follows the pointer.
    const move = (ev: PointerEvent) => {
      this.height = clampPreviewHeight(startHeight + (startY - ev.clientY), window.innerHeight);
    };
    const end = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', end);
      grip.removeEventListener('pointercancel', end);
      this.dragging = false;
      writeHeight(this.height);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', end);
    grip.addEventListener('pointercancel', end);
    e.preventDefault();
  }

  /** Keyboard resize, so the grip is not a mouse-only control. */
  private nudge(e: KeyboardEvent): void {
    const step = e.key === 'ArrowUp' ? 40 : e.key === 'ArrowDown' ? -40 : 0;
    if (step === 0) return;
    e.preventDefault();
    this.height = clampPreviewHeight(this.height + step, window.innerHeight);
    writeHeight(this.height);
  }

  private renderGrip() {
    return html`<div
      class=${`grip${this.dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the preview"
      tabindex="0"
      title="Drag to give the preview more or less room"
      @pointerdown=${this.startDrag}
      @keydown=${this.nudge}
    ></div>`;
  }

  override render() {
    if (this.rows.length === 0 || this.columns.length === 0) return this.renderEmpty();
    const cells = previewCells(this.columns, this.rows);
    return html`
      ${this.renderGrip()}
      <div class="preview" style=${styleMap({ maxHeight: `${this.height}px` })}>
        <h3>Live preview — first ${this.rows.length} row${this.rows.length === 1 ? '' : 's'}</h3>
        <table inert>
          <thead>
            <tr>
              ${this.columns.map((c) => html`<th title=${c.field}>${c.label || c.field}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${this.rows.map(
              (row, i) =>
                html`<tr>
                  ${this.columns.map((c, j) => this.renderCell(row, c, cells[i]?.[j]))}
                </tr>`,
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private renderEmpty() {
    const msg =
      this.state === 'loading'
        ? 'Reading rows for the preview…'
        : this.state === 'error'
          ? `The rows could not be read, so there is no preview${this.error ? `: ${this.error}` : '.'}${this.note ? ` ${this.note}` : ''}`
          : this.columns.length === 0 && this.rows.length > 0
            ? 'No columns to preview.'
            : 'No rows to preview.';
    return html`<div class="preview"><div class="empty" data-testid="preview-empty">${msg}</div></div>`;
  }

  /**
   * One cell, drawn the way the grid would draw it.
   *
   * A column whose script failed shows the failure in place of a value: there is
   * no value, and the stored cell it computes FROM is not what the grid will
   * show. A cell that breaks a rule keeps its value and is flagged, because the
   * point of the preview is to see which of your real rows the rule rejects.
   */
  private renderCell(row: Row, col: ColumnSpec, cell: PreviewCell | undefined) {
    if (!cell) return html`<td></td>`;
    if (cell.error) {
      return html`<td class="text violation" title=${cell.error}><span class="script-err">⚠ ${cell.error}</span></td>`;
    }
    const tag = col.renderer ? this.cellRenderers.get(col.renderer) : undefined;
    const classes = `${tag ? 'rendered' : 'text'}${cell.problem ? ' violation' : ''}`;
    if (!tag) {
      return html`<td class=${classes} title=${cell.problem ?? ''}>${previewText(cell.value)}</td>`;
    }
    // Data-driven tag names need lit's static-html; the same trade-off
    // `data-table` accepts, under the same host trust model.
    const el = unsafeStatic(tag);
    return staticHtml`<td class=${classes} title=${cell.problem ?? ''}><${el}
      .value=${cell.value ?? ''}
      .rawValue=${cell.raw ?? ''}
      .column=${col}
      .row=${row.data}
      .readonly=${true}
      .sourceReadonly=${true}
    ></${el}></td>`;
  }
}

/** The remembered height, or the default when there isn't one worth trusting. */
function readHeight(): number {
  const stored = readUserSetting(HEIGHT_SETTING);
  const px = typeof stored === 'number' ? stored : Number(stored);
  if (!Number.isFinite(px) || px <= 0) return PREVIEW_HEIGHT_DEFAULT;
  // Clamped on the way OUT as well as in: the window may be smaller than the one
  // the height was dragged on, and a pane taller than the screen has no grip.
  return clampPreviewHeight(px, window.innerHeight);
}

function writeHeight(px: number): void {
  writeUserSetting(HEIGHT_SETTING, px);
}

declare global {
  interface HTMLElementTagNameMap {
    'column-preview-table': ColumnPreviewTable;
  }
}
