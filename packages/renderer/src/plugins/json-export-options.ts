// packages/renderer/src/plugins/json-export-options.ts
//
// The JSON format's own fields in the export dialog. See `csv-export-options.ts`
// for the element contract the dialog expects (`value` + a `change` event).

import { LitElement, css, html } from 'lit';
import { customElement, state } from 'lit/decorators.js';

export interface JsonExportPanelValue {
  /** Indent the output. Off makes a much smaller file for the same data. */
  pretty: boolean;
  /**
   * Carry the workspace's view templates and the instances of the exported
   * tables, so a re-import restores the view windows and not only the data.
   * Only reaches the file when several tables are written as one dump.
   */
  includeViews: boolean;
}

export const JSON_EXPORT_DEFAULTS: JsonExportPanelValue = {
  pretty: true,
  includeViews: true,
};

@customElement('json-export-options')
export class JsonExportOptions extends LitElement {
  static override styles = css`
    :host {
      display: block;
    }
    .checks {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
    }
    label {
      font-size: 0.85rem;
      color: #374151;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
    }
    p.hint {
      color: #6b7280;
      font-size: 0.78rem;
      margin: 0.4rem 0 0;
    }
  `;

  @state() private pretty = JSON_EXPORT_DEFAULTS.pretty;
  @state() private includeViews = JSON_EXPORT_DEFAULTS.includeViews;

  get value(): JsonExportPanelValue {
    return { pretty: this.pretty, includeViews: this.includeViews };
  }

  private emit(): void {
    this.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  override render() {
    return html`
      <div class="checks">
        <label>
          <input
            type="checkbox"
            data-testid="json-pretty"
            .checked=${this.pretty}
            @change=${(e: Event) => {
              this.pretty = (e.target as HTMLInputElement).checked;
              this.emit();
            }}
          />
          Indent
        </label>
        <label>
          <input
            type="checkbox"
            data-testid="json-include-views"
            .checked=${this.includeViews}
            @change=${(e: Event) => {
              this.includeViews = (e.target as HTMLInputElement).checked;
              this.emit();
            }}
          />
          Include views
        </label>
      </div>
      <p class="hint">One table is written as a <code>.table.json</code>. Several become one <code>.db.json</code> dump, which is where the views can travel too.</p>
    `;
  }
}
