import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'cell-image',
  version: '0.1.0',
  description: 'Renders image-typed cells as a thumbnail with upload/clear.',
  author: 'easyDBAccess built-ins',
};

export function init(api: HostApi): void {
  if (!customElements.get('cell-image')) {
    customElements.define('cell-image', CellImage);
  }
  api.ui.registerCellRenderer('image', 'cell-image');
}

class CellImage extends HTMLElement {
  private _value = '';

  set value(v: string) {
    if (this._value === v) return;
    this._value = v ?? '';
    this.render();
  }
  get value() {
    return this._value;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
    this.innerHTML = '';
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:0.4rem';
    const isDataUri = typeof this._value === 'string' && this._value.startsWith('data:image');
    if (isDataUri) {
      const img = document.createElement('img');
      img.src = this._value;
      img.alt = '';
      img.style.cssText = 'max-height:32px;max-width:64px;border-radius:.15rem;border:1px solid #e5e7eb';
      wrap.append(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.style.color = '#9ca3af';
      placeholder.textContent = 'no image';
      wrap.append(placeholder);
    }
    const upload = document.createElement('button');
    upload.type = 'button';
    upload.textContent = isDataUri ? 'replace' : 'upload';
    upload.style.cssText = 'padding:0.1rem 0.4rem;font-size:0.75rem;cursor:pointer';
    upload.addEventListener('click', () => this.pickFile());
    wrap.append(upload);
    if (isDataUri) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.textContent = 'clear';
      clear.style.cssText = 'padding:0.1rem 0.4rem;font-size:0.75rem;cursor:pointer';
      clear.addEventListener('click', () => this.commit(''));
      wrap.append(clear);
    }
    this.append(wrap);
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
    this._value = v;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}
