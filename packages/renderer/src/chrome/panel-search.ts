import { LitElement, css, html } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';
import { materialIconStyles } from './material-icon-css.js';

/**
 * Collapsible search box that lives in a panel window's header toolbar. Default
 * state is a 🔍 icon; clicking expands into an input and focuses it. Clicking
 * outside (blur) collapses back to the icon. When a query is active the
 * collapsed icon is highlighted so the live filter stays discoverable. Each
 * keystroke dispatches an `easydb:table-search` event on document with
 * { tableId, query } so the matching <data-table> can filter its rows.
 */
@customElement('panel-search')
export class PanelSearch extends LitElement {
  static override styles = [
    materialIconStyles,
    css`
      :host {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
      }
      button.icon {
        background: transparent;
        border: 0;
        color: white;
        cursor: pointer;
        padding: 0 0.25rem;
        font-size: 0.95rem;
        line-height: 1;
      }
      button.icon:hover {
        opacity: 0.8;
      }
      button.icon.active {
        color: #93c5fd;
      }
      input {
        font: inherit;
        font-size: 0.85rem;
        padding: 0.15rem 0.4rem;
        border: 0;
        border-radius: 0.15rem;
        background: rgba(255, 255, 255, 0.9);
        color: #111;
        width: 11rem;
      }
      input:focus {
        outline: 2px solid #93c5fd;
        outline-offset: -1px;
      }
      .mi.sm {
        font-size: 0.95rem;
      }
    `,
  ];

  @property({ type: String }) tableId = '';
  @state() private query = '';
  @state() private open = false;
  @query('input') private inputEl?: HTMLInputElement;

  // Set when the box opens so `updated()` focuses the freshly-rendered input
  // exactly once. `autofocus` is unreliable here — it only fires on initial
  // document parse, not when Lit inserts the input on click.
  private focusPending = false;

  private dispatchQuery() {
    document.dispatchEvent(
      new CustomEvent('easydb:table-search', {
        detail: { tableId: this.tableId, query: this.query },
      }),
    );
  }

  private onInput = (e: Event) => {
    this.query = (e.target as HTMLInputElement).value;
    this.dispatchQuery();
  };

  private openSearch = () => {
    this.open = true;
    this.focusPending = true;
  };

  // Clicking outside the input blurs it; collapse back to the icon. Any active
  // query is preserved (the collapsed icon shows the highlighted state) so the
  // filter keeps applying.
  private onBlur = () => {
    this.open = false;
  };

  override updated() {
    if (this.focusPending && this.inputEl) {
      this.inputEl.focus();
      this.focusPending = false;
    }
  }

  override render() {
    if (!this.open) {
      const active = this.query.trim().length > 0;
      return html`<button
        class="icon ${active ? 'active' : ''}"
        title=${active ? `Filtering rows: ${this.query}` : 'Search rows in this table'}
        @click=${this.openSearch}
      >
        <span class="mi sm">search</span>
      </button>`;
    }
    return html`<input
      type="search"
      placeholder="search…"
      .value=${this.query}
      @input=${this.onInput}
      @blur=${this.onBlur}
    />`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'panel-search': PanelSearch;
  }
}
