// A small anchored dropdown menu portaled to <body>. Mirrors the filter-popover
// pattern (singleton, position:fixed against the viewport, capture-phase
// outside-click close). Self-mounts on first use (like top-progress) so callers
// only need `AnchoredMenu.open(rect, items)`.
import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { materialIconStyles } from './material-icon-css.js';

export interface AnchoredMenuItem {
  id: string;
  label: string;
  icon?: string | undefined;
  danger?: boolean | undefined;
}

let singleton: AnchoredMenu | null = null;
function host(): AnchoredMenu {
  if (!singleton) {
    singleton = document.createElement('anchored-menu') as AnchoredMenu;
    document.body.appendChild(singleton);
  }
  return singleton;
}

@customElement('anchored-menu')
export class AnchoredMenu extends LitElement {
  @state() private items: AnchoredMenuItem[] = [];
  @state() private shown = false;
  private resolveFn: ((id: string | null) => void) | null = null;

  /** Open the menu under `anchor` (a viewport-space rect). Resolves to the chosen id, or null. */
  static open(anchor: DOMRect, items: AnchoredMenuItem[]): Promise<string | null> {
    return host().openMenu(anchor, items);
  }

  static override styles = [
    materialIconStyles,
    css`
      :host {
        position: fixed;
        z-index: 150000;
      }
      :host([hidden]) {
        display: none;
      }
      .menu {
        background: #fff;
        border: 1px solid #e5e7eb;
        border-radius: 0.4rem;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
        padding: 0.25rem;
        min-width: 190px;
        /* Shadow DOM does not inherit the page font, so the buttons' inherited
           font would fall back to the browser default serif. Set the app's
           chrome font (system-ui) explicitly; the buttons inherit it. */
        font-family: system-ui, sans-serif;
        font-size: 0.875rem;
        color: #111;
        /* A value list (a view's filter chip offers every value of its field) can
           be hundreds of entries long, so the menu scrolls rather than growing
           past the viewport. Short menus are unaffected. */
        max-height: min(60vh, 420px);
        overflow-y: auto;
      }
      button {
        display: flex;
        align-items: center;
        gap: 0.55rem;
        width: 100%;
        border: 0;
        background: transparent;
        font: inherit;
        text-align: left;
        padding: 0.45rem 0.6rem;
        border-radius: 0.3rem;
        cursor: pointer;
        color: #111;
      }
      button:hover {
        background: #f3f4f6;
      }
      button.danger {
        color: #b91c1c;
      }
      .mi {
        font-size: 1.15rem;
        color: #6b7280;
      }
    `,
  ];

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('hidden', '');
  }

  private openMenu(anchor: DOMRect, items: AnchoredMenuItem[]): Promise<string | null> {
    this.items = items;
    this.style.left = `${Math.round(anchor.left)}px`;
    this.style.top = `${Math.round(anchor.bottom + 4)}px`;
    this.removeAttribute('hidden');
    this.shown = true;
    // The footer sits at the bottom of the viewport, so the menu usually needs
    // to open UPWARD. Flip it above the anchor if it would overflow the bottom.
    void this.updateComplete.then(() => {
      const menu = this.shadowRoot?.querySelector('.menu') as HTMLElement | null;
      if (!menu) return;
      const r = menu.getBoundingClientRect();
      if (r.bottom > window.innerHeight) {
        this.style.top = `${Math.round(anchor.top - r.height - 4)}px`;
      }
    });
    return new Promise<string | null>((resolve) => {
      this.resolveFn = resolve;
      setTimeout(() => {
        document.addEventListener('mousedown', this.onOutside, true);
        document.addEventListener('keydown', this.onKey, true);
      }, 0);
    });
  }

  private finish(id: string | null): void {
    this.setAttribute('hidden', '');
    this.shown = false;
    document.removeEventListener('mousedown', this.onOutside, true);
    document.removeEventListener('keydown', this.onKey, true);
    const resolve = this.resolveFn;
    this.resolveFn = null;
    queueMicrotask(() => resolve?.(id));
  }

  private onOutside = (e: MouseEvent): void => {
    if (!e.composedPath().includes(this)) this.finish(null);
  };
  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      this.finish(null);
    }
  };

  override render() {
    if (!this.shown) return html``;
    return html`
      <div class="menu" role="menu">
        ${this.items.map(
          (it) => html`
            <button role="menuitem" class=${it.danger ? 'danger' : ''} @click=${() => this.finish(it.id)}>
              ${it.icon ? html`<span class="mi">${it.icon}</span>` : ''}
              <span>${it.label}</span>
            </button>
          `,
        )}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'anchored-menu': AnchoredMenu;
  }
}
