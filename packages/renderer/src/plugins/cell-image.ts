import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-image',
  name: 'Cell Image',
  type: 'cell-renderer',
  version: '0.1.0',
  description:
    'Renderer for image cells: thumbnail with upload/clear. Apply by setting a column\'s renderer to "image". Values are kept as data: URIs.',
  author: 'easyDBAccess built-ins',
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
    const isDataUri =
      typeof this._value === 'string' &&
      (this._value.startsWith('data:image') || this._value.startsWith('http'));
    if (isDataUri) {
      const img = document.createElement('img');
      img.src = this._value;
      img.alt = '';
      img.style.cssText =
        'max-height:32px;max-width:64px;border-radius:.15rem;border:1px solid #e5e7eb';
      wrap.append(img);
    } else {
      const placeholder = document.createElement('span');
      placeholder.style.color = '#9ca3af';
      placeholder.textContent = 'no image';
      wrap.append(placeholder);
      const upload = document.createElement('button');
      upload.type = 'button';
      upload.textContent = 'upload';
      upload.style.cssText = 'padding:0.1rem 0.4rem;font-size:0.75rem;cursor:pointer';
      upload.addEventListener('click', () => this.pickFile());
      wrap.append(upload);
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
