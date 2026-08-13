// packages/renderer/src/plugins/csv-export-options.ts
//
// The CSV format's own fields in the export dialog, the mirror of
// `csv-import-options.ts` on the import side. The dialog mounts this element by
// tag name and reads `value` back, so it holds no import from the dialog and the
// dialog holds none from this plugin.

import { LitElement, css, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';

/** What `csv-export`'s serializer reads out of `ExportContext.panel`. */
export interface CsvExportPanelValue {
  separator: string;
  header: boolean;
  /** Prefix the file with a UTF-8 byte-order mark. */
  bom: boolean;
  /** Write the header in csv-import's `field:label:type:…` mini-language. */
  typedHeader: boolean;
  /** CRLF (the default, and what Excel expects) or LF. */
  crlf: boolean;
}

export const CSV_EXPORT_DEFAULTS: CsvExportPanelValue = {
  separator: ',',
  header: true,
  bom: false,
  typedHeader: false,
  crlf: true,
};

const SEPARATORS = [
  { value: ',', label: 'Comma  ,' },
  { value: ';', label: 'Semicolon  ;' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe  |' },
  { value: 'custom', label: 'Other…' },
];

@customElement('csv-export-options')
export class CsvExportOptions extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .row {
      display: flex;
      gap: 0.75rem;
      align-items: flex-end;
      flex-wrap: wrap;
    }
    label {
      font-size: 0.85rem;
      color: #374151;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }
    select,
    input[type='text'] {
      font: inherit;
      padding: 0.25rem 0.4rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      background: white;
    }
    input[type='text'] {
      width: 4rem;
    }
    .checks {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-top: 0.5rem;
    }
    p.hint {
      color: #6b7280;
      font-size: 0.78rem;
      margin: 0.4rem 0 0;
    }
  `;

  @state() private choice = CSV_EXPORT_DEFAULTS.separator;
  @state() private custom = '';
  @state() private header = CSV_EXPORT_DEFAULTS.header;
  @state() private bom = CSV_EXPORT_DEFAULTS.bom;
  @state() private typedHeader = CSV_EXPORT_DEFAULTS.typedHeader;
  @state() private crlf = CSV_EXPORT_DEFAULTS.crlf;

  /** Read by the export dialog and passed to the serializer as `ctx.panel`. */
  get value(): CsvExportPanelValue {
    const separator = this.choice === 'custom' ? this.custom || ',' : this.choice;
    return { separator, header: this.header, bom: this.bom, typedHeader: this.typedHeader, crlf: this.crlf };
  }

  private emit(): void {
    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  private check(label: string, get: () => boolean, set: (v: boolean) => void, testid: string) {
    return html`<label>
      <input
        type="checkbox"
        data-testid=${testid}
        .checked=${get()}
        @change=${(e: Event) => {
          set((e.target as HTMLInputElement).checked);
          this.emit();
        }}
      />
      ${label}
    </label>`;
  }

  override render() {
    return html`
      <div class="row">
        <label>
          Separator
          <select
            data-testid="csv-separator"
            .value=${this.choice}
            @change=${(e: Event) => {
              this.choice = (e.target as HTMLSelectElement).value;
              this.emit();
            }}
          >
            ${SEPARATORS.map((s) => html`<option value=${s.value} ?selected=${s.value === this.choice}>${s.label}</option>`)}
          </select>
        </label>
        ${this.choice === 'custom'
          ? html`<label>
              Character
              <input
                type="text"
                maxlength="1"
                placeholder="^"
                .value=${this.custom}
                @input=${(e: Event) => {
                  this.custom = (e.target as HTMLInputElement).value;
                  this.emit();
                }}
              />
            </label>`
          : nothing}
      </div>
      <div class="checks">
        ${this.check('Header row', () => this.header, (v) => (this.header = v), 'csv-header')}
        ${this.check('Byte-order mark', () => this.bom, (v) => (this.bom = v), 'csv-bom')}
        ${this.check('Typed header', () => this.typedHeader, (v) => (this.typedHeader = v), 'csv-typed-header')}
        ${this.check('CRLF line ends', () => this.crlf, (v) => (this.crlf = v), 'csv-crlf')}
      </div>
      <p class="hint">
        A typed header writes each column as <code>field:label:type</code>, so importing the file back restores the types instead of guessing them. A byte-order mark is what makes Excel read
        accented characters correctly.
      </p>
    `;
  }
}
