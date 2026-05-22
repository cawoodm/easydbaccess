import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

/**
 * Collapsible search box that lives in a jsPanel's header toolbar. Default
 * state is a 🔍 icon; clicking expands into an input. Empty input on blur
 * collapses back to the icon. Each keystroke dispatches an
 * `easydb:table-search` event on document with { tableId, query } so the
 * matching <data-table> can filter its rows.
 */
@customElement('panel-search')
export class PanelSearch extends LitElement {
  static override styles = css`
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
  `;

  @property({ type: String }) tableId = '';
  @state() private query = '';
  @state() private open = false;

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

  private onBlur = () => {
    if (this.query.trim().length === 0) this.open = false;
  };

  override render() {
    if (!this.open && this.query.length === 0) {
      return html`<button
        class="icon"
        title="Search rows in this table"
        @click=${() => (this.open = true)}
      >
        🔍
      </button>`;
    }
    return html`<input
      type="search"
      placeholder="search…"
      autofocus
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
