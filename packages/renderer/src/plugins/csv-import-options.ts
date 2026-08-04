// packages/renderer/src/plugins/csv-import-options.ts
//
// The CSV importer's own options panel. The Import dialog renders ONE common
// block (URL, file, mode, edit-columns, row limit) and then, below it, the
// panel the active importer declares via `ImporterSpec.panel`. This is that
// panel for `csv` — see .claude/plans/2026-07-28-importer-architecture.md.
//
// Contract with the dialog (plugin-api.ts, `ImporterSpec.panel`):
//   - the element exposes a `value` property, read into `ImportCtx.panel`
//   - it dispatches `change` whenever that value changes
//
// It lives in its own module because `csv-import.ts` is unit-tested under
// Vitest's default Node environment, where `customElements.define` does not
// exist. `csv-import.ts` pulls this in with a dynamic import from `init()`,
// which only ever runs in the browser.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

/** What this panel contributes to `ImportCtx.panel`. */
export interface CsvPanelValue {
  /** The separator character. Absent ⇒ let the parser detect it. */
  separator?: string;
}

/** Fixed choices. `custom` swaps in a free-text field for anything else. */
const CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Auto-detect' },
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
  { value: 'custom', label: 'Other…' },
];

@customElement('csv-import-options')
export class CsvImportOptions extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
      font-size: 0.85rem;
      color: #374151;
    }
    .row {
      display: flex;
      gap: 0.75rem;
    }
    .row > * {
      flex: 1;
    }
    select,
    input[type='text'] {
      font: inherit;
      padding: 0.45rem 0.55rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      width: 100%;
      box-sizing: border-box;
      background: white;
    }
    p.hint {
      color: #6b7280;
      font-size: 0.78rem;
      margin: 0.4rem 0 0;
    }
  `;

  /** The selected preset, or `custom`. Empty string ⇒ auto-detect. */
  @state() private choice = '';
  /** The character typed into "Other…". Only read when `choice === 'custom'`. */
  @state() private custom = '';

  /** Read by the Import dialog and passed to the importer as `ctx.panel`. */
  get value(): CsvPanelValue {
    const sep = this.choice === 'custom' ? this.custom : this.choice;
    return sep ? { separator: sep } : {};
  }

  private emit(): void {
    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="row">
        <label>
          Separator
          <select
            .value=${this.choice}
            @change=${(e: Event) => {
              this.choice = (e.target as HTMLSelectElement).value;
              this.emit();
            }}
          >
            ${CHOICES.map((c) => html`<option value=${c.value} ?selected=${c.value === this.choice}>${c.label}</option>`)}
          </select>
        </label>
        ${this.choice === 'custom'
          ? html`<label>
              Character
              <input
                type="text"
                maxlength="1"
                placeholder="e.g. ^"
                .value=${this.custom}
                @input=${(e: Event) => {
                  this.custom = (e.target as HTMLInputElement).value;
                  this.emit();
                }}
              />
            </label>`
          : nothing}
      </div>
      <p class="hint">
        Auto-detect counts commas, semicolons and tabs in the first lines. A
        <code>.tsv</code> or <code>.tab</code> name always means TAB. Choose a separator here to override both.
      </p>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'csv-import-options': CsvImportOptions;
  }
}
