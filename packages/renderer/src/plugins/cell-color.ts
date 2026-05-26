import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'cell-color',
  version: '0.1.0',
  description: 'Renderer for hex colour values: a native swatch picker. Apply by setting a column\'s renderer to "color".',
  author: 'easyDBAccess built-ins',
};

/**
 * Plugin that ships a `<cell-color>` custom element and registers it under
 * the renderer name `color`. Dogfoods api.ui.registerCellRenderer — the same
 * path third-party plugins use to swap in their own renderers.
 */
export function init(api: HostApi): void {
  if (!customElements.get('cell-color')) {
    customElements.define('cell-color', CellColor);
  }
  api.ui.registerCellRenderer('color', 'cell-color');
}

class CellColor extends HTMLElement {
  private _value = '';

  static get observedAttributes() {
    return ['value'];
  }

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

  attributeChangedCallback(_n: string, _o: string, n: string) {
    this.value = n;
  }

  private render() {
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(this._value) ? this._value : '#000000';
    this.innerHTML = '';
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.value = hex;
    picker.style.cssText =
      'width:1.5rem;height:1.25rem;padding:0;border:1px solid #d1d5db;background:transparent;vertical-align:middle;cursor:pointer';
    picker.addEventListener('change', () => this.commit(picker.value));
    this.append(picker);
  }

  private commit(v: string) {
    this._value = v;
    this.dispatchEvent(new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }));
  }
}
