import { LitElement, css, html } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import {
  composeColumnFilter,
  parseColumnFilter,
  type FilterToken,
} from '../search/column-filter.js';
import { materialIconStyles } from './material-icon-css.js';

/** Tri-state of one value in the picker: included, excluded, or unset. */
type ValueState = 'on' | 'not';

/** Map key for a token: its positive rendering, so modifiers stay distinct. */
function keyOf(token: FilterToken): string {
  return composeColumnFilter([{ ...token, negate: false }]);
}

/**
 * Portal-positioned dropdown for picking column-filter values from the set of
 * values actually present in the column. Mounted into document.body so it
 * escapes the data-table's overflow:auto clip boundary; the manager positions
 * it under the anchoring funnel button.
 *
 * Each value carries a tri-state checkbox — off (empty gray) → on (green ✓,
 * include) → not (red ✕, exclude) — and any number of values may be on or
 * negated at once. Toggling applies the composed filter LIVE through the
 * `onChange` callback and leaves the popover open; the promise resolves on
 * dismiss (null) or Clear filter ({ clear: true }).
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
      li .left {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        min-width: 0;
      }
      /* Tri-state checkbox: off (empty gray) → on (green ✓) → not (red ✕). */
      .cb {
        flex: 0 0 auto;
        width: 14px;
        height: 14px;
        border: 1px solid #9ca3af;
        border-radius: 0.15rem;
        background: #fff;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        line-height: 1;
        font-weight: 700;
        color: transparent;
        user-select: none;
      }
      .cb.on {
        border-color: #16a34a;
        background: #dcfce7;
        color: #15803d;
      }
      .cb.not {
        border-color: #dc2626;
        background: #fee2e2;
        color: #b91c1c;
      }
      .hint {
        padding: 0.3rem 0.55rem;
        border-bottom: 1px solid #e5e7eb;
        color: #6b7280;
        font-size: 0.75rem;
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
  /**
   * Tri-state per token, keyed by the token's POSITIVE rendering (`Sweden`,
   * `^S`, `"Berlin, DE"`). Keying on the rendering — not the bare term — keeps
   * a hand-typed `^S` distinct from a literal value `S`, and carries modifiers
   * like `^` through a toggle instead of silently dropping them. Insertion
   * order is preserved so the composed filter string stays stable.
   */
  @state() private states = new Map<string, { state: ValueState; token: FilterToken }>();
  private resolveFn: ((v: string | null | { clear: true }) => void) | null = null;
  private onChange: ((filter: string) => void) | null = null;
  /**
   * Whether a value toggled here composes an EXACT token (`=Sweden`) instead of
   * the default substring one (`Sweden`).
   *
   * The caller's layer decides. A grid column filter is a substring match, which
   * is what someone typing into that box expects. A view's filter CHIP is not
   * typed — it came from clicking one cell's value — so its tokens are exact,
   * and this flag is how the picker reads and writes the same shape instead of
   * adding a second, looser token beside the one already there.
   */
  private exactValues = false;

  /**
   * Opens the popover anchored to a DOM rect. Toggling a value applies the
   * recomposed filter immediately via `onChange` and keeps the popover open;
   * the promise resolves null on dismiss or { clear: true } on Clear-filter.
   */
  open(
    anchor: DOMRect,
    values: Array<{ value: string; count: number }>,
    current: string,
    blanks = 0,
    onChange?: (filter: string) => void,
    opts?: { exact?: boolean | undefined },
  ): Promise<string | null | { clear: true }> {
    this.values = values;
    this.blanks = blanks;
    this.onChange = onChange ?? null;
    this.exactValues = opts?.exact === true;
    // Seed the tri-states from the active filter so re-opening shows what's on.
    this.states = new Map(
      parseColumnFilter(current ?? '').map((t) => [
        keyOf(t),
        { state: t.negate ? ('not' as const) : ('on' as const), token: t },
      ]),
    );
    this.current = current ?? '';
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

  /**
   * Cycle one value off → on → not → off and apply the recomposed filter.
   *
   * `exact` defaults to the layer's setting; the (Blanks) row passes false
   * explicitly, because bare `NULL` is the grammar's blank-cell match while
   * `=NULL` would look for the literal text "null".
   */
  private cycle(value: string, exact = this.exactValues) {
    const token: FilterToken = exact
      ? { term: value, negate: false, exact: true }
      : { term: value, negate: false };
    const key = keyOf(token);
    const next = new Map(this.states);
    const entry = next.get(key);
    if (entry === undefined) next.set(key, { state: 'on', token });
    else if (entry.state === 'on') next.set(key, { state: 'not', token: entry.token });
    else next.delete(key);
    this.states = next;
    const tokens: FilterToken[] = [...next.values()].map((e) => ({
      ...e.token,
      negate: e.state === 'not',
    }));
    this.current = composeColumnFilter(tokens);
    this.onChange?.(this.current);
  }

  private close(v: string | null | { clear: true }) {
    this.onChange = null;
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
    const stateOf = (value: string, exact = this.exactValues): ValueState | undefined =>
      this.states.get(
        keyOf(exact ? { term: value, negate: false, exact: true } : { term: value, negate: false }),
      )?.state;
    const box = (state: ValueState | undefined) => html`
      <span class=${`cb${state ? ` ${state}` : ''}`}
        >${state === 'on' ? '✓' : state === 'not' ? '✕' : ''}</span
      >
    `;
    const rowTitle = (state: ValueState | undefined) =>
      state === 'on'
        ? 'Included — click to exclude'
        : state === 'not'
          ? 'Excluded — click to clear'
          : 'Click to include → exclude → off';
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
      <div class="hint">Click a value: include (✓) → exclude (✕) → off.</div>
      ${filtered.length === 0 && !showBlanks
        ? html`<div class="empty">No matching values.</div>`
        : html`<ul>
            ${showBlanks
              ? html`
                  <li
                    class="blanks"
                    title=${rowTitle(stateOf('NULL', false))}
                    @click=${() => this.cycle('NULL', false)}
                  >
                    <span class="left">
                      ${box(stateOf('NULL', false))}
                      <span class="label"><em>(Blanks)</em></span>
                    </span>
                    <span class="count">${this.blanks}</span>
                  </li>
                `
              : ''}
            ${filtered.slice(0, 500).map((v) => {
              const state = stateOf(v.value);
              return html`
                <li title=${rowTitle(state)} @click=${() => this.cycle(v.value)}>
                  <span class="left">
                    ${box(state)}
                    <span class="label">${v.value}</span>
                  </span>
                  <span class="count">${v.count}</span>
                </li>
              `;
            })}
          </ul>`}
      ${this.values.length > 500
        ? html`<div class="cap" style="padding:0 .55rem">Showing first 500 of ${this.values.length}.</div>`
        : ''}
      <div class="actions">
        <button
          class="text"
          @click=${() => {
            this.states = new Map();
            this.close({ clear: true });
          }}
        >
          Clear filter
        </button>
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
