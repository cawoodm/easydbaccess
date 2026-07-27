import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { materialIconStyles } from './material-icon-css.js';

/**
 * Portal-positioned dropdown for picking a column-filter value from the set
 * of values actually present in the column. Mounted into document.body so it
 * escapes the data-table's overflow:auto clip boundary; the manager
 * positions it under the anchoring funnel button.
 *
 * Resolves the user's choice via a callback set when opened.
 */
@customElement('filter-popover')
export class FilterPopover extends LitElement {
  static instance: FilterPopover | null = null;

  static override styles = [
    materialIconStyles,
    css`
      :host {
        position: fixed;
        z-index: 150000;
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 0.35rem;
        box-shadow: 0 10px 25px rgba(0, 0, 0, 0.18);
        min-width: 220px;
        max-width: 320px;
        max-height: 360px;
        display: flex;
        flex-direction: column;
        font: 0.85rem system-ui, sans-serif;
        overflow: hidden;
      }
      :host([hidden]) {
        display: none;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.35rem 0.45rem;
        border-bottom: 1px solid #e5e7eb;
        background: #f9fafb;
      }
      header input {
        flex: 1;
        font: inherit;
        padding: 0.2rem 0.4rem;
        border: 1px solid #d1d5db;
        border-radius: 0.2rem;
      }
      header button.icon {
        background: transparent;
        border: 0;
        cursor: pointer;
        color: #6b7280;
        padding: 0 0.1rem;
      }
      header button.icon:hover {
        color: #111;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        overflow: auto;
        flex: 1;
      }
      li {
        padding: 0.25rem 0.55rem;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        gap: 0.5rem;
        align-items: center;
      }
      li:hover {
        background: #eff6ff;
      }
      li.selected {
        background: #dbeafe;
      }
      li .count {
        color: #6b7280;
        font-variant-numeric: tabular-nums;
        font-size: 0.78rem;
      }
      li .label {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      li.blanks .label {
        color: #6b7280;
      }
      .hide-row {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.3rem 0.55rem;
        border-bottom: 1px solid #e5e7eb;
        color: #374151;
        cursor: pointer;
        user-select: none;
      }
      .hide-row input {
        margin: 0;
        cursor: pointer;
      }
      .empty {
        padding: 0.6rem;
        color: #9ca3af;
        font-style: italic;
      }
      .actions {
        display: flex;
        justify-content: space-between;
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
      .cap {
        color: #9ca3af;
        font-size: 0.78rem;
        font-style: italic;
      }
    `,
  ];

  @property({ type: Array }) values: Array<{ value: string; count: number }> = [];
  /** Number of blank (null / empty / whitespace) cells in the faceted set. */
  @property({ type: Number }) blanks = 0;
  /** The bare (un-negated) term of the current filter, for selection highlight. */
  @property({ type: String }) current = '';
  @state() private search = '';
  /** When checked, the picked value is negated (`!value`) — "hide these rows". */
  @state() private hide = false;
  private resolveFn: ((v: string | null | { clear: true }) => void) | null = null;

  /**
   * Opens the popover anchored to a DOM rect. Resolves with the picked filter
   * string (with a leading `!` when "hide" is checked, or `NULL`/`!NULL` for
   * the Blanks entry), null on dismiss, or { clear: true } on Clear-filter.
   */
  open(
    anchor: DOMRect,
    values: Array<{ value: string; count: number }>,
    current: string,
    blanks = 0,
  ): Promise<string | null | { clear: true }> {
    this.values = values;
    this.blanks = blanks;
    // Split the current filter into its negation flag + bare term so the
    // "hide" checkbox and the selected row reflect the active filter.
    let term = current ?? '';
    let negate = false;
    if (term.startsWith('!')) {
      negate = true;
      term = term.slice(1).trim();
    }
    this.hide = negate;
    this.current = term;
    this.search = '';
    this.style.top = `${Math.round(anchor.bottom + 4)}px`;
    this.style.left = `${Math.round(anchor.left)}px`;
    this.removeAttribute('hidden');
    return new Promise((res) => {
      this.resolveFn = res;
      // Click outside to dismiss
      setTimeout(() => document.addEventListener('mousedown', this.onOutside, true), 0);
    });
  }

  /** Resolve with `term`, prefixing `!` when the "hide" box is checked. */
  private pick(term: string) {
    this.close((this.hide ? '!' : '') + term);
  }

  private close(v: string | null | { clear: true }) {
    document.removeEventListener('mousedown', this.onOutside, true);
    this.setAttribute('hidden', '');
    const fn = this.resolveFn;
    this.resolveFn = null;
    fn?.(v);
  }

  private onOutside = (e: MouseEvent) => {
    const path = e.composedPath();
    if (!path.includes(this)) this.close(null);
  };

  override connectedCallback() {
    super.connectedCallback();
    FilterPopover.instance = this;
    this.setAttribute('hidden', '');
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (FilterPopover.instance === this) FilterPopover.instance = null;
  }

  override render() {
    const q = this.search.toLowerCase();
    const filtered = this.values.filter((v) => v.value.toLowerCase().includes(q));
    const showBlanks = this.blanks > 0 && '(blanks)'.includes(q);
    const blanksSelected = this.current.toUpperCase() === 'NULL';
    return html`
      <header>
        <span class="mi sm">search</span>
        <input
          type="text"
          autofocus
          placeholder="Filter values…"
          .value=${this.search}
          @input=${(e: Event) => (this.search = (e.target as HTMLInputElement).value)}
        />
        <button
          class="icon"
          title="Close"
          @click=${() => this.close(null)}
        >
          <span class="mi sm">close</span>
        </button>
      </header>
      <label class="hide-row" title="Show rows that do NOT match the value you pick">
        <input
          type="checkbox"
          .checked=${this.hide}
          @change=${(e: Event) => (this.hide = (e.target as HTMLInputElement).checked)}
        />
        hide
      </label>
      ${filtered.length === 0 && !showBlanks
        ? html`<div class="empty">No matching values.</div>`
        : html`<ul>
            ${showBlanks
              ? html`
                  <li
                    class=${`blanks${blanksSelected ? ' selected' : ''}`}
                    @click=${() => this.pick('NULL')}
                  >
                    <span class="label"><em>(Blanks)</em></span>
                    <span class="count">${this.blanks}</span>
                  </li>
                `
              : ''}
            ${filtered.slice(0, 500).map(
              (v) => html`
                <li
                  class=${v.value === this.current ? 'selected' : ''}
                  @click=${() => this.pick(v.value)}
                >
                  <span class="label">${v.value}</span>
                  <span class="count">${v.count}</span>
                </li>
              `,
            )}
          </ul>`}
      ${this.values.length > 500
        ? html`<div class="cap" style="padding:0 .55rem">Showing first 500 of ${this.values.length}.</div>`
        : ''}
      <div class="actions">
        <button class="text" @click=${() => this.close({ clear: true })}>Clear filter</button>
        <span style="color:#6b7280">${filtered.length} value${filtered.length === 1 ? '' : 's'}</span>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'filter-popover': FilterPopover;
  }
}
