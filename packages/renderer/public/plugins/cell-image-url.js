/**
 * cell-image-url — renderer that treats the cell value as an image URL.
 *
 * The cell's stored value is dropped straight into an <img src="...">.
 * Useful when your dataset already references hosted images by URL (or a
 * relative path served alongside the app) and you don't want to inline
 * data: URIs the way the built-in `image` renderer does.
 *
 * Loaded by URL from the plugin catalog. Plain JS — no bare imports —
 * because the host wraps the body in a Blob URL and dynamic-imports it.
 */

export const meta = {
  name: 'cell-image-url',
  version: '0.1.0',
  description:
    'Renders the cell value as <img src=value>. Apply by setting a column\'s renderer to "image-url".',
  author: 'easyDBAccess reference',
};

export function init(api) {
  if (!customElements.get('cell-image-url')) {
    customElements.define('cell-image-url', CellImageUrl);
  }
  api.ui.registerCellRenderer('image-url', 'cell-image-url');
}

class CellImageUrl extends HTMLElement {
  constructor() {
    super();
    this._value = '';
    this._editing = false;
  }

  set value(v) {
    const s = v == null ? '' : String(v);
    if (this._value === s) return;
    this._value = s;
    this._editing = false;
    this.render();
  }
  get value() {
    return this._value;
  }

  connectedCallback() {
    this.render();
  }

  render() {
    this.innerHTML = '';
    const v = this._value.trim();
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:0.4rem;width:100%';

    if (v && !this._editing) {
      const img = document.createElement('img');
      img.src = v;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.style.cssText =
        'max-height:32px;max-width:64px;border-radius:.15rem;border:1px solid #e5e7eb;object-fit:contain';
      img.addEventListener('error', () => {
        // Image failed to load — show a small broken-image hint so it's
        // obvious the URL is the problem, not just an empty cell.
        img.replaceWith(makeBroken(v));
      });

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.title = 'Edit URL';
      edit.textContent = '✎';
      edit.style.cssText =
        'background:transparent;border:0;cursor:pointer;color:#9ca3af;font-size:0.85em;padding:0 0.15rem;line-height:1';
      edit.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._editing = true;
        this.render();
      });

      wrap.append(img, edit);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'image URL';
      input.value = this._value;
      input.style.cssText =
        'width:100%;box-sizing:border-box;border:0;background:transparent;font:inherit;padding:0';
      input.addEventListener('change', () => this.commit(input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commit(input.value);
        } else if (e.key === 'Escape') {
          this._editing = false;
          this.render();
        }
      });
      wrap.append(input);
      if (this._editing) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      }
    }

    this.append(wrap);
  }

  commit(v) {
    this._value = v;
    this._editing = false;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

function makeBroken(url) {
  const span = document.createElement('span');
  span.textContent = '⚠';
  span.title = `Failed to load: ${url}`;
  span.style.cssText = 'color:#ef4444;font-size:0.9em';
  return span;
}
