import type { HostApi, PluginModule } from '@easydb/shared';
import { makePencil, makeValueEditor, pencilRow } from './cell-pencil.js';
import { imageSrcFrom } from '../util/image-source.js';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-image',
  name: 'Cell Image',
  type: 'cell-renderer',
  version: '0.1.0',
  description: 'Renderer for image cells: thumbnail with upload/clear. Apply by setting a column\'s renderer to "image". Values are kept as data: URIs.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-image.ts',
};

export function init(api: HostApi): void {
  if (!customElements.get('cell-image')) {
    customElements.define('cell-image', CellImage);
  }
  api.ui.registerCellRenderer('image', 'cell-image');
}

class CellImage extends HTMLElement {
  /**
   * Not necessarily a string: a photo column read from a database hands over
   * bytes (a `Uint8Array`, or the object one becomes through JSON). What it can
   * be rendered as is `imageSrcFrom`'s problem, not this setter's.
   */
  private _value: unknown = '';
  private _readonly = false;
  private _editing = false;
  /** The input allowed to commit — see `makeValueEditor`. */
  private _editor: HTMLInputElement | null = null;

  set value(v: unknown) {
    if (this._value === v) return;
    this._value = v ?? '';
    this._editing = false;
    this.render();
  }
  get value(): unknown {
    return this._value;
  }

  // A read-only view offers no pencil and no upload.
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

    // Edit mode: the raw URL / data: URI, plus a shortcut back to the file
    // picker. A thumbnail hides the value completely, so this is the only way
    // to see or retype the source of an image that is already set.
    if (this._editing) {
      const row = document.createElement('span');
      row.style.cssText = 'display:flex;align-items:center;gap:0.25rem;width:100%;min-width:0;max-width:100%';
      const input = makeValueEditor({
        // Only a text value is editable text. A blob is megabytes of bytes with
        // no useful string form, so the editor opens empty and typing a URL
        // replaces it — which is what the pencil is for.
        value: typeof this._value === 'string' ? this._value : '',
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
      const upload = document.createElement('button');
      upload.type = 'button';
      upload.textContent = 'upload';
      upload.style.cssText = 'flex:none;padding:0.1rem 0.4rem;font-size:0.75rem;cursor:pointer';
      upload.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus off the blur path
      upload.addEventListener('click', () => this.pickFile());
      row.append(input, upload);
      this.append(row);
      this._editor = input;
      return;
    }

    const content = document.createElement('span');
    content.style.cssText = 'display:flex;align-items:center;gap:0.4rem;min-width:0';
    // Whatever the importer left in the cell: a data URI, a URL, a SQL hex blob
    // (`X'ffd8…'`, how a database photo column arrives), raw bytes or bare
    // base64. `imageSrcFrom` reads the type from the bytes and returns null for
    // anything that is not an image.
    const src = imageSrcFrom(this._value);
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.style.cssText = 'max-height:32px;max-width:64px;border-radius:.15rem;border:1px solid #e5e7eb';
      content.append(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.style.color = '#9ca3af';
      placeholder.textContent = 'no image';
      content.append(placeholder);
      if (!this._readonly) {
        const upload = document.createElement('button');
        upload.type = 'button';
        upload.textContent = 'upload';
        upload.style.cssText = 'flex:none;padding:0.1rem 0.4rem;font-size:0.75rem;cursor:pointer';
        upload.addEventListener('click', () => this.pickFile());
        content.append(upload);
      }
    }
    this.append(this._readonly ? content : pencilRow(content, this.pencil()));
  }

  /** The pencil that swaps the thumbnail for a raw-value editor. */
  private pencil(): HTMLElement {
    return makePencil(() => {
      this._editing = true;
      this.render();
    }, 'Edit the image URL');
  }

  private pickFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => this.commit(String(reader.result));
      reader.readAsDataURL(file);
    });
    input.click();
  }

  private commit(v: string) {
    const changed = v !== this._value;
    this._value = v;
    this._editing = false;
    // Repaint ourselves: the host writes the stored value back through the
    // `value` setter, but that setter early-returns when the value is unchanged
    // — and we just assigned it — so the thumbnail would never come back.
    this.render();
    if (!changed) return;
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
  }
}
