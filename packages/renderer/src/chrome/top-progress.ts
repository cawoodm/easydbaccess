// packages/renderer/src/chrome/top-progress.ts
//
// A thin progress bar pinned to the very top of the viewport, above all chrome.
// It is the global "something is loading" indicator for work that has no window
// of its own yet — chiefly reading an import URL before its table exists.
//
// The bar is only ever shown deliberately: callers reveal it (via `begin`) after
// a slow-threshold elapses, so quick operations never flash it. It is
// determinate when a fraction is supplied and an indeterminate moving sliver
// otherwise. Multiple concurrent operations ref-count visibility.

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

export interface ProgressHandle {
  /** Set the 0..1 fraction, or null for indeterminate. */
  fraction(f: number | null): void;
  /** End this operation; the bar hides when the last active one ends. */
  done(): void;
}

let singleton: TopProgress | null = null;
function host(): TopProgress {
  if (!singleton) {
    singleton = document.createElement('top-progress') as TopProgress;
    document.body.appendChild(singleton);
  }
  return singleton;
}

@customElement('top-progress')
export class TopProgress extends LitElement {
  @state() private visible = false;
  @state() private frac: number | null = null;
  @state() private label = '';
  private active = new Set<symbol>();

  /** Start showing the bar; returns a handle to update/close this operation. */
  static begin(label = ''): ProgressHandle {
    return host().begin(label);
  }

  begin(label: string): ProgressHandle {
    const token = Symbol('progress');
    this.active.add(token);
    this.label = label;
    this.frac = null;
    this.visible = true;
    return {
      fraction: (f: number | null) => {
        if (this.active.has(token)) this.frac = f;
      },
      done: () => {
        this.active.delete(token);
        if (this.active.size === 0) {
          this.visible = false;
          this.frac = null;
          this.label = '';
        }
      },
    };
  }

  static override styles = css`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      z-index: 10000;
      pointer-events: none;
    }
    .track {
      position: absolute;
      inset: 0;
      overflow: hidden;
    }
    .bar {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 0;
      background: #2563eb;
    }
    .bar.determinate {
      transition: width 0.15s ease;
    }
    .bar.indet {
      width: 35%;
      animation: eda-top-progress 1.1s ease-in-out infinite;
    }
    @keyframes eda-top-progress {
      0% {
        left: -35%;
      }
      100% {
        left: 100%;
      }
    }
  `;

  override render() {
    if (!this.visible) return html``;
    const determinate = this.frac != null;
    return html`<div
      class="track"
      role="progressbar"
      aria-label=${this.label || 'Loading'}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow=${determinate ? Math.round((this.frac as number) * 100) : ''}
    >
      ${determinate
        ? html`<div
            class="bar determinate"
            style="width:${Math.round((this.frac as number) * 100)}%"
          ></div>`
        : html`<div class="bar indet"></div>`}
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'top-progress': TopProgress;
  }
}
