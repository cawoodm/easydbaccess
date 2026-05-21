import { LitElement, css, html } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import type { ButtonSpec, HostApi } from '@easydb/shared';
import { getContext } from '../app-context.js';
import './workspace-selector.js';
import './table-list.js';
import '../dialogs/new-table-dialog.js';
import type { NewTableDialog } from '../dialogs/new-table-dialog.js';

@customElement('app-shell')
export class AppShell extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100vh;
      font-family: system-ui, sans-serif;
      background: #f3f4f6;
    }
    header,
    footer {
      background: #1f2937;
      color: white;
      padding: 0.5rem 1rem;
      display: flex;
      align-items: center;
      gap: 0.75rem;
      position: relative;
      z-index: 100000;
    }
    header strong,
    footer .spacer {
      flex: 1;
    }
    footer button.slot {
      background: transparent;
      color: white;
      border: 1px solid #4b5563;
      padding: 0.3rem 0.7rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font: inherit;
    }
    footer button.slot:hover {
      background: #374151;
    }
    header .version {
      opacity: 0.5;
      font-size: 0.75rem;
      margin-left: 0.5rem;
    }
    button.primary {
      background: #3b82f6;
      color: white;
      border: 0;
      padding: 0.4rem 0.75rem;
      border-radius: 0.25rem;
      cursor: pointer;
      font: inherit;
    }
    button.primary:hover {
      background: #2563eb;
    }
    main {
      flex: 1;
      overflow: hidden;
      position: relative;
    }
    :host(.drag-over) main::after {
      content: 'Drop CSV here';
      position: absolute;
      inset: 0.75rem;
      border: 2px dashed #3b82f6;
      border-radius: 0.5rem;
      display: grid;
      place-items: center;
      background: rgba(59, 130, 246, 0.06);
      color: #2563eb;
      font-weight: 600;
      pointer-events: none;
    }
  `;

  @query('new-table-dialog') private dialog!: NewTableDialog;
  @state() private footerButtons: ButtonSpec[] = [];
  @state() private headerButtons: ButtonSpec[] = [];
  private api: HostApi | null = null;

  override connectedCallback() {
    super.connectedCallback();
    this.addEventListener('dragover', this.onDragOver);
    this.addEventListener('dragleave', this.onDragLeave);
    this.addEventListener('drop', this.onDrop);
    void this.bindRegistries();
  }

  private async bindRegistries() {
    const ctx = await getContext();
    this.api = ctx.api;
    // Snapshot now, then re-snapshot when app:ready fires (built-ins register
    // during load(), which runs after init resolves).
    this.snapshotRegistries(ctx);
    ctx.events.on('app:ready', () => this.snapshotRegistries(ctx));
  }

  private snapshotRegistries(ctx: { registries: { footerButtons: ButtonSpec[]; headerButtons: ButtonSpec[] } }) {
    this.footerButtons = [...ctx.registries.footerButtons];
    this.headerButtons = [...ctx.registries.headerButtons];
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.removeEventListener('dragover', this.onDragOver);
    this.removeEventListener('dragleave', this.onDragLeave);
    this.removeEventListener('drop', this.onDrop);
  }

  private onDragOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    this.classList.add('drag-over');
  };

  private onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget && this.contains(e.relatedTarget as Node)) return;
    this.classList.remove('drag-over');
  };

  private onDrop = async (e: DragEvent) => {
    this.classList.remove('drag-over');
    if (!hasFiles(e)) return;
    e.preventDefault();
    const ctx = await getContext();
    const files = Array.from(e.dataTransfer?.files ?? []);
    ctx.events.emit('drop:files', { files, event: e });
    for (const fn of [...ctx.registries.dropHandlers]) {
      try {
        const handled = await fn(e, ctx.api);
        if (handled) return;
      } catch (err) {
        ctx.events.emit('plugin:error', {
          url: '(drop-handler)',
          phase: 'runtime',
          error: err,
        });
      }
    }
  };

  private newTable = () => {
    this.dialog.open();
  };

  private runSlot = (spec: ButtonSpec) => {
    if (!this.api) return;
    void Promise.resolve(spec.onClick(this.api)).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[footer-button:${spec.id}]`, err);
    });
  };

  override render() {
    return html`
      <header>
        <strong>easyDBAccess <span class="version">v0.0.0</span></strong>
        ${this.headerButtons.map(
          (b) => html`
            <button class="slot" title=${b.tooltip ?? ''} @click=${() => this.runSlot(b)}>
              ${b.label}
            </button>
          `,
        )}
        <button class="primary" @click=${this.newTable}>+ New Table</button>
      </header>
      <main><table-list></table-list></main>
      <footer>
        <workspace-selector></workspace-selector>
        <span class="spacer"></span>
        ${this.footerButtons.map(
          (b) => html`
            <button class="slot" title=${b.tooltip ?? ''} @click=${() => this.runSlot(b)}>
              ${b.label}
            </button>
          `,
        )}
      </footer>
      <new-table-dialog></new-table-dialog>
    `;
  }
}

function hasFiles(e: DragEvent): boolean {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types && Array.from(dt.types).includes('Files')) return true;
  return (dt.files?.length ?? 0) > 0;
}

declare global {
  interface HTMLElementTagNameMap {
    'app-shell': AppShell;
  }
}
