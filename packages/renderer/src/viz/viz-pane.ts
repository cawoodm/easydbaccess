// packages/renderer/src/viz/viz-pane.ts
//
// `<viz-pane>` — the chrome around a docked visualization: a title strip with a
// collapse caret, an undock button and a close button, wrapped around a
// `<viz-panel>`.
//
// A docked pane has no titlebar of its own — it lives inside somebody else's
// window — so without this there is no way to tell what a chart is, no way to get
// it out again, and no way to shut it. The three controls each map to one field on
// the instance, which is what keeps this element free of any logic: collapse
// writes `dock.size`, undock clears `dock`, close clears `open`. The reconciler in
// `view-window-manager.ts` does the rest.

import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { getContext } from '../app-context.js';
import { materialIconStyles } from '../chrome/material-icon-css.js';
import { openViewsDialog } from '../dialogs/views-dialog.js';
import { dockIconStyles, popOutIcon } from './dock-icons.js';
import './viz-panel.js';

/** Height the strip alone occupies when the pane is collapsed. */
export const PANE_HEADER_H = 22;

@customElement('viz-pane')
export class VizPane extends LitElement {
  static override styles = [
    materialIconStyles,
    dockIconStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        height: 100%;
        overflow: hidden;
        background: var(--eda-pane-bg, transparent);
        font:
          11px/1.3 system-ui,
          sans-serif;
      }
      .strip {
        flex: none;
        display: flex;
        align-items: center;
        gap: 2px;
        height: ${PANE_HEADER_H}px;
        padding: 0 2px 0 4px;
        background: rgba(127, 127, 127, 0.12);
        border-bottom: 1px solid rgba(127, 127, 127, 0.2);
        user-select: none;
      }
      .title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 600;
        opacity: 0.85;
      }
      button {
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 0;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.7;
      }
      button:hover {
        background: rgba(127, 127, 127, 0.25);
        opacity: 1;
      }
      button .mi {
        font-size: 14px;
        line-height: 1;
      }
      /* The SVG pop-out icon matches the font icons beside it. The shared rule
         sizes it for the window footer's 1rem row; this strip's icons are 14px.
         (No backticks in here — they would end the css template.) */
      button .dock-icon {
        width: 14px;
        height: 14px;
      }
      .body {
        flex: 1;
        min-height: 0;
        overflow: hidden;
      }
      :host([collapsed]) .body {
        display: none;
      }
    `,
  ];

  @property({ type: String }) viewInstanceId = '';
  @property({ type: String }) label = '';
  @property({ type: Boolean, reflect: true }) collapsed = false;

  @state() private busy = false;

  /** Forwarded so the window manager can refresh a pane like a window. */
  async reload(): Promise<void> {
    const panel = this.renderRoot.querySelector('viz-panel') as (HTMLElement & { reload?: () => Promise<void> }) | null;
    await panel?.reload?.();
  }

  private async patch(patch: Record<string, unknown>): Promise<void> {
    if (this.busy || !this.viewInstanceId) return;
    this.busy = true;
    try {
      const ctx = await getContext();
      await ctx.store.viewInstances.patch(this.viewInstanceId, { ...patch, updatedAt: Date.now() });
    } finally {
      this.busy = false;
    }
  }

  /**
   * Collapse is local, not persisted.
   *
   * The persisted `dock.size` is the height the user chose; overwriting it on
   * collapse would lose it, and storing a second "collapsed" flag to avoid that
   * buys a field for a state that is cheap to re-create. So a collapsed pane
   * reopens at its own height next session — which is also the less surprising
   * of the two behaviours.
   */
  private toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.dispatchEvent(new CustomEvent('viz-pane-collapse', { detail: { collapsed: this.collapsed }, bubbles: true, composed: true }));
  }

  /**
   * The two ways back into the configuration, exactly as `viz-footer` offers
   * them for a windowed visualization.
   *
   * A docked pane has no footer to hang a toolbar off (that is the host
   * window's), so both live in the strip. It carried only ONE pencil before,
   * which meant the definition — the kind, the aggregate, the shared options —
   * was unreachable from a docked pane without undocking it first.
   *
   * Icons are the shared convention: `code` is the DEFINITION everywhere it
   * appears, `tune` is THIS view's settings. Two buttons that both looked like a
   * pencil would be two buttons nobody could tell apart in a 22px strip.
   */
  private async openEditor(what: 'template' | 'instance'): Promise<void> {
    if (!this.viewInstanceId) return;
    const ctx = await getContext();
    const inst = await ctx.store.viewInstances.findOne(this.viewInstanceId);
    if (!inst) return;
    openViewsDialog(inst.tableId, what === 'template' ? { editTemplateId: inst.templateId } : { editInstanceId: this.viewInstanceId });
  }

  /** Ask the embedded panel to re-read its data. */
  private async refresh(): Promise<void> {
    const panel = this.renderRoot.querySelector('viz-panel') as (HTMLElement & { refreshNow?: () => Promise<void> }) | null;
    await panel?.refreshNow?.();
  }

  /** Undock: clear `dock` and let the reconciler open it as a window instead. */
  private undock(): void {
    void this.patch({ dock: undefined });
  }

  /** Close: same flag a window's close writes, so both routes agree. */
  private close(): void {
    void this.patch({ open: false });
  }

  override render() {
    return html`
      <div class="strip">
        <button @click=${this.toggleCollapse} title=${this.collapsed ? 'Expand' : 'Collapse'} aria-label=${this.collapsed ? 'Expand' : 'Collapse'} aria-expanded=${this.collapsed ? 'false' : 'true'}>
          <span class="mi sm">${this.collapsed ? 'chevron_right' : 'expand_more'}</span>
        </button>
        <span class="title" title=${this.label}>${this.label}</span>
        <button @click=${() => void this.openEditor('template')} title="Edit the definition: kind, aggregate and the options every view of it shares" aria-label="Edit definition">
          <span class="mi sm">code</span>
        </button>
        <button @click=${() => void this.openEditor('instance')} title="Settings for THIS view: its columns, its limit, and any option it overrides" aria-label="Settings for this view">
          <span class="mi sm">tune</span>
        </button>
        <button @click=${() => void this.refresh()} title="Re-read the data and redraw" aria-label="Refresh">
          <span class="mi sm">refresh</span>
        </button>
        <button @click=${this.undock} title="Open in its own window" aria-label="Open in its own window">${popOutIcon}</button>
        <button @click=${this.close} title="Close" aria-label="Close">
          <span class="mi sm">close</span>
        </button>
      </div>
      <div class="body">
        <viz-panel .viewInstanceId=${this.viewInstanceId} style="height:100%"></viz-panel>
      </div>
    `;
  }
}
