/**
 * cell-link — URL/phone link cell renderer, dynamically loaded from the catalog.
 *
 * Overrides string-cell rendering: http(s) URLs render as <a target=_blank>,
 * phone-like values as <a href=tel:>. Non-matching values fall back to the
 * default text input. Demonstrates the override-the-default-renderer pattern
 * for the `string` cell type.
 *
 * Plain JS — no bare imports — because the host wraps the body in a Blob URL
 * and dynamic-imports it; bare specifiers wouldn't resolve in that context.
 */

export const meta = {
  name: 'cell-link',
  version: '0.1.0',
  description:
    'Renders http(s) URLs and phone-like values in string cells as clickable links. A pencil toggles to edit mode.',
  author: 'easyDBAccess reference',
};

export function init(api) {
  if (!customElements.get('cell-link')) {
    customElements.define('cell-link', CellLink);
  }
  api.ui.registerCellRenderer('string', 'cell-link');
}

class CellLink extends HTMLElement {
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
    const v = this._value;
    const url = !this._editing ? detectUrl(v) : null;
    const tel = !this._editing && !url ? detectPhone(v) : null;

    if (url || tel) {
      const wrap = document.createElement('span');
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:0.25rem;width:100%';
      const a = document.createElement('a');
      a.href = url ? v : `tel:${v.replace(/[^\d+]/g, '')}`;
      if (url) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.textContent = v;
      a.style.cssText =
        'color:#2563eb;text-decoration:underline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      a.title = url ? `Open ${v}` : `Call ${v}`;

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.title = 'Edit';
      edit.textContent = '✎';
      edit.style.cssText =
        'background:transparent;border:0;cursor:pointer;color:#9ca3af;font-size:0.85em;padding:0 0.15rem;line-height:1';
      edit.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._editing = true;
        this.render();
      });

      wrap.append(a, edit);
      this.append(wrap);
    } else {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = v;
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
      this.append(input);
      if (this._editing) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      }
    }
  }

  commit(v) {
    this._value = v;
    this._editing = false;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

function detectUrl(s) {
  const t = s.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  return null;
}

/**
 * Phone-shape detector. Accepts strings made of digits plus the usual
 * separators (+, space, parens, dot, hyphen) where the digit count falls in
 * the ITU E.164 range of 7–15. Conservative so we don't promote numeric IDs
 * or product codes into clickable phone links.
 */
function detectPhone(s) {
  const t = s.trim();
  if (!t) return null;
  if (!/^[+0-9 ()\-.]+$/.test(t)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const hasSeparator = /[ ()\-.]/.test(t);
  const hasPlus = t.startsWith('+');
  if (!hasSeparator && !hasPlus && digits.length < 10) return null;
  return t;
}
