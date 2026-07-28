import { LitElement, css, html, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators.js';

/**
 * Combobox-style filter input for the per-column filter row in <data-table>.
 *
 * Replaces the native <datalist> autocomplete, whose behavior is browser-
 * specific and unstyleable (no counts, inconsistent open/close, substring
 * matching varies). Behaves like the minniDBMax v1 column-filter dropdown:
 * the user types freely, an anchored value list appears below the input,
 * clicking a value fills the input and applies the filter.
 *
 * Positioning uses `position: fixed` against the input's bounding rect, so
 * the dropdown escapes the table's `overflow:auto` clip without needing a
 * document.body portal. Only one combobox can be focused at a time, so we
 * don't have to coordinate with other instances.
 *
 * The dropdown closes when the input loses focus, and when nothing matches it
 * is not rendered at all — either way it never sits over the filtered rows.
 * Both the list and its items swallow `mousedown`, so clicking an option (or
 * dragging the list's scrollbar) keeps the input focused instead of dismissing
 * the list before the click lands.
 *
 * Emits `filter-change` (CustomEvent<{ value: string }>) on every keystroke
 * AND on option pick — callers treat both identically.
 */
@customElement('filter-combobox')
export class FilterCombobox extends LitElement {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
    }
    .wrap {
      position: relative;
      display: block;
    }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d1d5db;
      border-radius: 0.2rem;
      background: white;
      font: inherit;
      font-size: 0.8rem;
      padding: 0.1rem 1.1rem 0.1rem 0.3rem;
    }
    input::placeholder {
      color: #9ca3af;
      font-style: italic;
    }
    input:focus {
      outline: 2px solid #3b82f6;
      outline-offset: -2px;
    }
    button.clear {
      position: absolute;
      right: 0.15rem;
      top: 50%;
      transform: translateY(-50%);
      width: 0.95rem;
      height: 0.95rem;
      padding: 0;
      border: 0;
      background: transparent;
      color: #9ca3af;
      cursor: pointer;
      font-size: 0.85rem;
      line-height: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 50%;
    }
    button.clear:hover {
      color: #111827;
      background: #e5e7eb;
    }
    .dropdown {
      position: fixed;
      z-index: 150000;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      box-shadow: 0 8px 20px rgba(0, 0, 0, 0.18);
      max-height: 260px;
      max-width: 360px;
      overflow: auto;
      font: inherit;
      font-size: 0.8rem;
      margin: 0;
      padding: 0.15rem 0;
      list-style: none;
    }
    .dropdown li {
      padding: 0.2rem 0.5rem;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .dropdown li:hover,
    .dropdown li.highlighted {
      background: #eff6ff;
    }
  `;

  @property({ type: String }) value = '';
  @property({ type: Array }) options: string[] = [];
  @property({ type: String }) placeholder = 'filter…';

  @state() private open = false;
  @state() private highlightIdx = -1;
  @state() private dropTop = 0;
  @state() private dropLeft = 0;
  @state() private dropMinWidth = 160;
  /**
   * True once the user has typed in the input since the dropdown opened.
   * Until then the dropdown shows the full faceted option list — otherwise,
   * re-opening a column whose filter is already set to one of its values
   * (e.g. "apple") would narrow the dropdown to just that value, hiding the
   * sibling values the user came back to switch to.
   */
  @state() private editing = false;

  @query('input') private inputEl?: HTMLInputElement;

  /**
   * Dropdown contents. Full faceted list when the user hasn't typed yet;
   * substring-narrowed by the current input value once they start editing.
   */
  private filtered(): string[] {
    const MAX = 500;
    if (!this.editing) return this.options.slice(0, MAX);
    const q = (this.value ?? '').trim().toLowerCase();
    if (!q) return this.options.slice(0, MAX);
    const out: string[] = [];
    for (const o of this.options) {
      if (o.toLowerCase().includes(q)) {
        out.push(o);
        if (out.length >= MAX) break;
      }
    }
    return out;
  }

  private positionDropdown() {
    if (!this.inputEl) return;
    const r = this.inputEl.getBoundingClientRect();
    this.dropTop = Math.round(r.bottom + 2);
    this.dropLeft = Math.round(r.left);
    this.dropMinWidth = Math.max(160, Math.round(r.width));
  }

  private openDropdown() {
    if (this.open) return;
    this.positionDropdown();
    this.open = true;
    this.editing = false;
    this.highlightIdx = -1;
    document.addEventListener('pointerdown', this.onOutside, true);
    // capture-phase listener catches scrolls of any ancestor too — data-table
    // has its own overflow:auto, and the panel itself can be moved.
    window.addEventListener('scroll', this.onWindowChange, true);
    window.addEventListener('resize', this.onWindowChange);
  }

  private closeDropdown() {
    if (!this.open) return;
    this.open = false;
    document.removeEventListener('pointerdown', this.onOutside, true);
    window.removeEventListener('scroll', this.onWindowChange, true);
    window.removeEventListener('resize', this.onWindowChange);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.closeDropdown();
  }

  private onOutside = (e: Event) => {
    const path = e.composedPath();
    if (path.includes(this)) return;
    this.closeDropdown();
  };

  private onWindowChange = () => {
    if (this.open) this.positionDropdown();
  };

  private fire(value: string) {
    this.value = value;
    this.dispatchEvent(
      new CustomEvent('filter-change', {
        detail: { value },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onInput = (e: Event) => {
    const v = (e.target as HTMLInputElement).value;
    this.fire(v);
    if (!this.open) this.openDropdown();
    this.editing = true;
    this.highlightIdx = -1;
  };

  private onPick(v: string) {
    this.fire(v);
    this.closeDropdown();
    // Re-focus the input but leave editing=false so a subsequent open shows
    // the full facet list again (user might want to pick a different value).
    this.editing = false;
    this.inputEl?.focus();
  }

  private onClear = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    this.fire('');
    this.editing = false;
    this.highlightIdx = -1;
    this.inputEl?.focus();
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const opts = this.filtered();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!this.open) {
        this.openDropdown();
        return;
      }
      this.highlightIdx = Math.min(this.highlightIdx + 1, opts.length - 1);
      this.scrollHighlightIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!this.open) {
        this.openDropdown();
        return;
      }
      this.highlightIdx = Math.max(this.highlightIdx - 1, 0);
      this.scrollHighlightIntoView();
    } else if (e.key === 'Enter') {
      const opt = opts[this.highlightIdx];
      if (opt !== undefined) {
        e.preventDefault();
        this.onPick(opt);
      } else if (this.open) {
        // Plain Enter with no highlight just closes — the typed value is
        // already applied via @input.
        this.closeDropdown();
      }
    } else if (e.key === 'Escape') {
      if (this.open) {
        e.preventDefault();
        this.closeDropdown();
      }
    }
  };

  private scrollHighlightIntoView() {
    // Re-query after the render. Defer one microtask so the updated
    // .highlighted class is applied first.
    queueMicrotask(() => {
      const ul = this.renderRoot.querySelector('ul.dropdown');
      const item = ul?.children[this.highlightIdx] as HTMLElement | undefined;
      item?.scrollIntoView({ block: 'nearest' });
    });
  }

  override render() {
    const opts = this.open ? this.filtered() : [];
    // No suggestions ⇒ no dropdown at all. An empty "No matching values." box
    // is pure obstruction: it sits over the rows the typed filter just found.
    // `open` stays true, so the list reappears as soon as something matches.
    const showDropdown = this.open && opts.length > 0;
    const style = `top:${this.dropTop}px;left:${this.dropLeft}px;min-width:${this.dropMinWidth}px;`;
    return html`
      <div class="wrap">
        <input
          type="text"
          placeholder=${this.placeholder}
          .value=${this.value}
          @focus=${() => this.openDropdown()}
          @click=${() => this.openDropdown()}
          @blur=${() => this.closeDropdown()}
          @input=${this.onInput}
          @keydown=${this.onKeyDown}
        />
        ${this.value
          ? html`<button
              type="button"
              class="clear"
              title="Clear filter"
              tabindex="-1"
              @mousedown=${(e: Event) => e.preventDefault()}
              @click=${this.onClear}
            >
              ×
            </button>`
          : nothing}
      </div>
      ${showDropdown
        ? html`<ul
            class="dropdown"
            style=${style}
            @mousedown=${(e: Event) => e.preventDefault()}
          >
            ${opts.map(
              (v, i) => html`
                <li
                  class=${i === this.highlightIdx ? 'highlighted' : ''}
                  @mousedown=${(e: Event) => e.preventDefault()}
                  @click=${() => this.onPick(v)}
                >
                  ${v}
                </li>
              `,
            )}
          </ul>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'filter-combobox': FilterCombobox;
  }
}
