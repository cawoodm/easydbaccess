// packages/renderer/src/chrome/app-progress.ts
//
// One app-wide progress bar, under the header, for work that is not confined to
// a single window.
//
// It exists for the convert/import path. Every table a convert creates is
// minimized (see `db-import.ts`'s phase 1), so the per-window bars inside the
// grids are not on screen at all, and the only signal was a row counter in each
// dock chip. A 40 MB file then looks like a hang for a minute — which is the
// exact complaint this answers.
//
// Driven by a document event rather than a property so a plugin can raise it
// without reaching into the shell, matching how `setTableLoading` already works.
// The event and its two helpers live in `app-progress-signal.ts` so a reporter
// does not have to import Lit — see the comment there.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import { APP_PROGRESS_EVENT, type AppProgressDetail } from './app-progress-signal.js';

@customElement('app-progress')
export class AppProgress extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .wrap {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.3rem 0.75rem;
      background: #eef2ff;
      border-bottom: 1px solid #c7d2fe;
      font-size: 0.78rem;
      color: #3730a3;
    }
    .label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .detail {
      color: #6366f1;
      white-space: nowrap;
    }
    .bar {
      flex: 1;
      height: 4px;
      border-radius: 2px;
      background: #c7d2fe;
      overflow: hidden;
    }
    .fill {
      height: 100%;
      background: #4f46e5;
    }
    /* Indeterminate: work has started but nothing has reported yet. A sliding
       sliver says "running" without claiming a position it does not know. */
    .fill:not(.determinate) {
      width: 30%;
      animation: eda-app-progress 1.1s ease-in-out infinite;
    }
    .fill.determinate {
      transition: width 0.15s linear;
    }
    .pct {
      min-width: 2.5rem;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    @keyframes eda-app-progress {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(333%);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .fill:not(.determinate) {
        animation: none;
        width: 100%;
        opacity: 0.5;
      }
    }
  `;

  @state() private label = '';
  @state() private fraction: number | undefined = undefined;
  @state() private detail = '';

  private readonly onProgress = (e: Event): void => {
    const d = (e as CustomEvent<AppProgressDetail>).detail;
    this.label = d.label ?? '';
    this.fraction = d.fraction;
    this.detail = d.detail ?? '';
  };

  override connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener(APP_PROGRESS_EVENT, this.onProgress);
  }

  override disconnectedCallback(): void {
    document.removeEventListener(APP_PROGRESS_EVENT, this.onProgress);
    super.disconnectedCallback();
  }

  override render() {
    if (!this.label) return nothing;
    const pct = this.fraction == null ? null : Math.round(Math.min(1, Math.max(0, this.fraction)) * 100);
    return html`
      <div class="wrap" role="status" aria-live="polite">
        <span class="label">${this.label}</span>
        <span class="bar">
          <span class="fill ${pct == null ? '' : 'determinate'}" style=${pct == null ? '' : `width:${pct}%`}></span>
        </span>
        ${this.detail ? html`<span class="detail">${this.detail}</span>` : nothing}
        <span class="pct">${pct == null ? '' : `${pct}%`}</span>
      </div>
    `;
  }
}
