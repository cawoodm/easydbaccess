// packages/renderer/src/chrome/filter-picker-shell.ts
//
// The chrome every custom funnel dropdown needs: the native popover plumbing,
// anchoring, the ← / title header, the Clear footer, and the promise that
// settles on dismiss / clear / fallback.
//
// Extracted with a single tenant, which is normally the wrong call. The reason
// is specific: this layer carries three rules the root CLAUDE.md lists as having
// already bitten this codebase, and all three are invisible when they are wrong.
//
//   1. A `:host` rule that sets `display` must restate the closed state, or the
//      UA rule that hides a closed popover loses and the panel stays on screen.
//   2. Escape must be claimed with a capture-phase `preventDefault`. The browser
//      closes a popover on Escape silently, and `panel-shell` — which checks
//      `defaultPrevented` — would then close the table window behind it.
//   3. No outside-click listener. Light dismiss belongs to the browser, which
//      already knows not to count the click that opened the popover.
//
// A copy-paste of those into a second picker is the failure this file prevents.
//
// LIMIT: a built-in plugin may import this; a URL-loaded plugin may not, because
// those are self-contained ES modules with no bare imports. A third-party picker
// writes its own chrome.

import { LitElement, css, html, type TemplateResult } from 'lit';
import { state } from 'lit/decorators.js';
import type { FilterPickerResult } from '@easydb/shared';
import { materialIconStyles } from './material-icon-css.js';

/**
 * Base class for a filter picker. A subclass defines the custom element,
 * implements `open()` to call `openShell`, and renders its body through
 * `renderShell`.
 */
export abstract class FilterPickerShell extends LitElement {
  static filterPickerStyles = [
    materialIconStyles,
    css`
      /* A native popover. The UA's own [popover] rules — centred by inset:0 +
         margin:auto, its own border, padding and background — are all overridden
         here; position:fixed stays, because openShell writes viewport pixels
         to left/top.

         NOTE: no backticks anywhere inside this CSS template literal — one
         would close it and the file would not parse. */
      :host {
        position: fixed;
        inset: auto;
        margin: 0;
        padding: 0;
        z-index: 150000;
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 0.35rem;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.18);
        min-width: 240px;
        max-width: 320px;
        display: flex;
        flex-direction: column;
        font:
          0.85rem system-ui,
          sans-serif;
        overflow: hidden;
        color: inherit;
      }
      /* The UA hides a closed popover with display:none. The :host rule above
         sets display:flex unconditionally, which would win and leave it on
         screen, so the closed state has to be restated. */
      :host(:not(:popover-open)) {
        display: none;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.35rem 0.45rem;
        border-bottom: 1px solid #e5e7eb;
        background: #f9fafb;
        font-weight: 600;
      }
      header .title {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      button.icon {
        background: transparent;
        border: 0;
        cursor: pointer;
        color: #6b7280;
        padding: 0 0.1rem;
        display: inline-flex;
        align-items: center;
      }
      button.icon:hover {
        color: #111;
      }
      .body {
        overflow: auto;
        flex: 1;
      }
      .actions {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.3rem 0.45rem;
        border-top: 1px solid #e5e7eb;
        background: #f9fafb;
      }
      button.text {
        background: transparent;
        border: 0;
        color: #2563eb;
        font: inherit;
        cursor: pointer;
        padding: 0;
      }
      button.text:hover {
        text-decoration: underline;
      }
    `,
  ];

  @state() protected shellTitle = '';
  private resolveFn: ((v: FilterPickerResult) => void) | null = null;
  /**
   * True while the BROWSER is closing the popover, so `settle` does not call
   * `hidePopover()` re-entrantly from inside the UA's own hide algorithm.
   */
  private uaClosing = false;

  /** Show the popover under `anchor` and return the promise its buttons settle. */
  protected openShell(anchor: DOMRect): Promise<FilterPickerResult> {
    // Settle any previous opening FIRST, before this call's state is written.
    if (this.resolveFn) this.settle(null);
    this.style.top = `${Math.round(anchor.bottom + 4)}px`;
    this.style.left = `${Math.round(anchor.left)}px`;
    if (!this.matches(':popover-open')) this.showPopover();
    return new Promise((res) => {
      this.resolveFn = res;
      document.addEventListener('keydown', this.onKey, true);
    });
  }

  /** Finish this opening with a result, hiding the popover. */
  protected settle(result: FilterPickerResult): void {
    document.removeEventListener('keydown', this.onKey, true);
    // Cleared before hiding: hiding fires `beforetoggle` synchronously, and that
    // handler must see this opening as already settled.
    const fn = this.resolveFn;
    this.resolveFn = null;
    if (!this.uaClosing && this.matches(':popover-open')) this.hidePopover();
    fn?.(result);
  }

  /** Header (← + title), body, and a Clear footer. */
  protected renderShell(title: string, body: TemplateResult): TemplateResult {
    return html`
      <header>
        <button class="icon" title="Back to the list of values" aria-label="Back to the list of values" @click=${() => this.settle({ fallback: true })}>
          <span class="mi sm">arrow_back</span>
        </button>
        <span class="title">${title}</span>
        <button class="icon" title="Close" aria-label="Close" @click=${() => this.settle(null)}>
          <span class="mi sm">close</span>
        </button>
      </header>
      <div class="body">${body}</div>
      <div class="actions">
        <button class="text" @click=${() => this.settle({ clear: true })}>Clear filter</button>
      </div>
    `;
  }

  /**
   * The browser closed it — a light dismiss (click outside). Replaces the
   * capture-phase mousedown listener this would otherwise need.
   */
  private onBeforeToggle = (e: ToggleEvent) => {
    if (e.newState !== 'closed') return;
    this.uaClosing = true;
    try {
      this.settle(null);
    } finally {
      this.uaClosing = false;
    }
  };

  /**
   * Escape dismisses. The browser would close the popover by itself, but
   * silently; capture phase + preventDefault is this app's "I claimed this key",
   * which `panel-shell`'s Escape handler checks before closing a window.
   * Anything already applied stays applied — each change was written as it was
   * made, and Escape here means "I am done", not "undo".
   */
  private onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this.settle(null);
  };

  override connectedCallback() {
    super.connectedCallback();
    // `auto`: light dismiss and the top layer come free, and the top layer is
    // what lets this escape the data-table's overflow clip and the canvas
    // transform without a z-index high enough to beat both.
    this.popover = 'auto';
    this.addEventListener('beforetoggle', this.onBeforeToggle as EventListener);
  }
}
