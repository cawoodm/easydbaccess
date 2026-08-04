// packages/renderer/src/plugins/markup-cell.ts
//
// The cell shared by the two renderers that show a value AS markup: `html`
// renders it unchanged, `markdown` converts it first. Everything else about them
// is the same — full height, no truncation, no popup, and a pencil on the right
// that opens the SOURCE in a textarea.
//
// "Source" is the load-bearing word, the same as in `html-cell-editor.ts`: on a
// scripted column the cell shows the script's OUTPUT, so the pencil must open the
// stored value the script reads, or a save would destroy it.

import { iconButton, openHtmlEditor, PENCIL_SVG } from './html-cell-editor.js';

/**
 * Base for a cell that renders its value as markup.
 *
 * A subclass says which language it speaks (`language`) and how to get HTML out
 * of it (`toHtml`). The rendered markup is deliberately NOT a click target: a
 * click used to swap it for a text input, which meant a link inside the value
 * could not be followed and a body-sized value had to be edited in a one-line
 * input. The pencil separates viewing from editing.
 */
export class MarkupCell extends HTMLElement {
  /** The language the STORED value is written in. Shown in the pencil tooltip. */
  protected readonly language: string = 'HTML';

  /** Value → the HTML to put in the cell. Identity for an `html` column. */
  protected toHtml(value: string): string {
    return value;
  }

  private _value = '';
  /** The STORED cell, set by data-table only on a scripted column. */
  private _source: string | undefined;
  private _label: string | undefined;

  set value(v: string) {
    const next = v ?? '';
    if (this._value === next) return;
    this._value = next;
    this.render();
  }
  get value() {
    return this._value;
  }

  // On a scripted column `value` is the script's OUTPUT; `rawValue` is what the
  // script reads. The pencil must edit that, not the output.
  set rawValue(v: unknown) {
    this._source = v == null ? '' : String(v);
  }

  set column(c: { label?: string } | undefined) {
    this._label = c?.label;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;align-items:flex-start;gap:0.25rem;width:100%';

    const view = document.createElement('span');
    view.style.cssText = 'flex:1 1 auto;min-width:0';
    if (this._value) {
      view.innerHTML = this.toHtml(this._value);
    } else {
      view.style.color = '#9ca3af';
      view.textContent = 'empty';
    }

    const pencil = iconButton(PENCIL_SVG, `Edit the ${this.language}`);
    pencil.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openEditor();
    });

    wrap.append(view, pencil);
    this.append(wrap);
  }

  private openEditor() {
    const scripted = this._source !== undefined;
    const title = `Edit ${this._label ?? this.language}`;
    openHtmlEditor(title, scripted ? this._source! : this._value, (next) => {
      if (scripted) {
        // The script re-runs on the new source and pushes a fresh `value` back
        // in, so there is nothing to render here.
        this._source = next;
      } else {
        this._value = next;
        this.render();
      }
      this.dispatchEvent(
        new CustomEvent('change', { detail: { value: next }, bubbles: true, composed: true }),
      );
    });
  }
}
