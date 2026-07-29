import type { ColumnSpec, HostApi, PluginModule } from '@easydb/shared';
import { makePencil, makeValueEditor, pencilRow } from './cell-pencil.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-script',
  name: 'Cell Script',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Power-user renderer that runs a user-authored render(row) JS body (column.script) and injects the returned HTML. Apply by setting a column\'s renderer to "script".',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-script.ts',
};

/** Defines `<cell-script>` and registers it under the renderer name `script`. */
export function init(api: HostApi): void {
  if (!customElements.get('cell-script')) customElements.define('cell-script', CellScript);
  api.ui.registerCellRenderer('script', 'cell-script');
}

/**
 * Power-user renderer: the user supplies a JS body on the column
 * (`column.script`) that must define `function render(row) { … }`. We
 * compile once per unique source, invoke per cell, and inject the
 * returned string as raw HTML. Throws and non-string returns surface as
 * a small inline error chip so a single broken script doesn't blow up
 * the rest of the row.
 *
 * Trust model: the plugin host already allows user-supplied code to do
 * anything in the page, so column scripts are no worse. The user
 * authored the script by clicking the pencil in the column editor.
 */
class CellScript extends HTMLElement {
  private _column: ColumnSpec | null = null;
  private _row: Record<string, unknown> = {};
  private _value: unknown = '';
  private _readonly = false;
  private _editing = false;
  /** The input allowed to commit — see `makeValueEditor`. */
  private _editor: HTMLInputElement | null = null;

  set column(c: ColumnSpec | null) {
    this._column = c;
    // Never repaint over an open editor. data-table re-binds `.row` with a
    // freshly-read object on EVERY table render, so identity always differs and
    // this setter fires constantly — it would otherwise throw away whatever the
    // user is typing the moment any row in the table changes.
    if (this._editing) return;
    this.render();
  }
  get column(): ColumnSpec | null {
    return this._column;
  }

  set row(r: Record<string, unknown> | null | undefined) {
    this._row = (r ?? {}) as Record<string, unknown>;
    if (this._editing) return;
    this.render();
  }
  get row(): Record<string, unknown> {
    return this._row;
  }

  // The script reads from `.row`, so the rendered OUTPUT ignores this. We still
  // keep it: it's this column's stored value, and the pencil edits it. (It used
  // to be discarded, which is why a script cell had no way back to its value.)
  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v;
    this._editing = false;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  // A read-only view offers no pencil.
  set readonly(v: boolean) {
    const n = !!v;
    if (this._readonly === n) return;
    this._readonly = n;
    this.render();
  }
  get readonly(): boolean {
    return this._readonly;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    this._editor = null;
    this.style.display = 'block';
    this.style.minWidth = '0';
    this.style.overflow = 'hidden';

    if (this._editing) {
      const input = makeValueEditor({
        value: this._value == null ? '' : String(this._value),
        onCommit: (v) => this.commit(v),
        onCancel: () => {
          // Disown the editor before re-rendering: removing it fires a blur
          // that must not save the edit being cancelled.
          this._editor = null;
          this._editing = false;
          this.render();
        },
        isLive: (el) => this._editor === el,
      });
      this.append(input);
      this._editor = input;
      return;
    }

    this.append(
      this._readonly ? this.renderOutput() : pencilRow(this.renderOutput(), this.pencil()),
    );
  }

  /** The pencil that swaps the rendered output for a raw-value editor. */
  private pencil(): HTMLElement {
    return makePencil(() => {
      this._editing = true;
      this.render();
    }, 'Edit the stored value');
  }

  /** The script's own output, or an inline chip explaining why there is none. */
  private renderOutput(): HTMLElement {
    const src = this._column?.script;
    if (!src || !src.trim()) {
      const placeholder = document.createElement('span');
      placeholder.textContent = '(no script)';
      placeholder.style.cssText = 'color:#9ca3af;font-style:italic';
      return placeholder;
    }
    let fn: (row: unknown) => unknown;
    try {
      fn = compileScript(src);
    } catch (err) {
      return makeErrorChip('compile error', err);
    }
    let out: unknown;
    try {
      out = fn(this._row);
    } catch (err) {
      return makeErrorChip('runtime error', err);
    }
    if (typeof out !== 'string') {
      return makeErrorChip('render(row) did not return a string', null);
    }
    const host = document.createElement('span');
    host.style.cssText = 'display:block;width:100%';
    // Raw HTML injection — exactly what the user asked the renderer for.
    // Inline <script> tags are inert when assigned via innerHTML so this
    // does not bypass the page's existing trust boundaries.
    host.innerHTML = out;
    return host;
  }

  private commit(v: string) {
    const changed = v !== this._value;
    this._value = v;
    this._editing = false;
    this.render();
    if (!changed) return;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

const compiledScripts = new Map<string, (row: unknown) => unknown>();

function compileScript(src: string): (row: unknown) => unknown {
  const cached = compiledScripts.get(src);
  if (cached) return cached;
  // The user's body defines `render`; we then call it with the bound row.
  // Wrapping in a function lets them also have `const` declarations,
  // imports of `Date`/`Math`, etc., scoped to the function.
  const fn = new Function('row', `${src}\nreturn render(row);`) as (row: unknown) => unknown;
  compiledScripts.set(src, fn);
  return fn;
}

function makeErrorChip(label: string, err: unknown): HTMLElement {
  const chip = document.createElement('span');
  chip.textContent = `⚠ ${label}`;
  chip.style.cssText =
    'color:#b91c1c;font-size:0.8em;font-family:ui-monospace,SFMono-Regular,monospace';
  if (err) {
    const msg = err instanceof Error ? err.message : String(err);
    chip.title = msg;
  }
  return chip;
}
