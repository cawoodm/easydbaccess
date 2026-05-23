import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  name: 'cell-link',
  version: '0.1.0',
  description:
    'Overrides string-cell rendering: http(s) URLs render as <a target=_blank>, phone-like values as <a href=tel:>. Non-matching values fall back to the default text input.',
  author: 'easyDBAccess built-ins',
};

/**
 * Demonstrates the override-the-default-renderer pattern: this plugin claims
 * the 'string' cell type, which is the default for most columns. Inside the
 * custom element we decide per-value whether to render a link or to fall back
 * to a normal <input>, so unrelated string cells are unaffected.
 *
 * A small pencil icon next to a rendered link toggles into edit mode (an
 * input); committing the edit (blur or Enter) swaps back to view mode.
 */
export function init(api: HostApi): void {
  if (!customElements.get('cell-link')) {
    customElements.define('cell-link', CellLink);
  }
  api.ui.registerCellRenderer('string', 'cell-link');
}

class CellLink extends HTMLElement {
  private _value = '';
  private _editing = false;

  set value(v: unknown) {
    const s = v == null ? '' : String(v);
    if (this._value === s) return;
    this._value = s;
    this._editing = false;
    this.render();
  }
  get value(): string {
    return this._value;
  }

  connectedCallback() {
    this.render();
  }

  private render() {
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
      // Edit mode OR value doesn't look link-shaped — render the default input.
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
        // Defer focus until the input is in the DOM.
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      }
    }
  }

  private commit(v: string) {
    this._value = v;
    this._editing = false;
    this.dispatchEvent(
      new CustomEvent('change', { detail: { value: v }, bubbles: true, composed: true }),
    );
  }
}

function detectUrl(s: string): string | null {
  const t = s.trim();
  if (/^https?:\/\/\S+$/i.test(t)) return t;
  return null;
}

/**
 * Phone-shape detector. Accepts strings made up of digits plus the usual
 * separators (+, space, parens, dot, hyphen) where the digit count falls in
 * the ITU E.164 range of 7–15. Deliberately conservative so we don't promote
 * numeric IDs or product codes into clickable phone links.
 */
function detectPhone(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (!/^[+0-9 ()\-.]+$/.test(t)) return null;
  // Reject date-shaped strings up front so 2024-01-15 / 15/03/2024 don't get
  // turned into "phone" links by virtue of containing hyphens or slashes.
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
  if (/^\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}$/.test(t)) return null;
  // Reject anything that doesn't look like real-world phone formatting:
  // require at least one separator OR a leading '+', OR length >= 10. Bare
  // 7-digit integers without separators are more likely IDs than phones.
  const digits = t.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  const hasSeparator = /[ ()\-.]/.test(t);
  const hasPlus = t.startsWith('+');
  if (!hasSeparator && !hasPlus && digits.length < 10) return null;
  return t;
}
