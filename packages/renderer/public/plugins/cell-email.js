/**
 * cell-email — renderer that turns email addresses into mailto: links.
 *
 * Loaded by URL from the plugin catalog. Plain JS — no bare imports —
 * because the host wraps the body in a Blob URL and dynamic-imports it.
 *
 * Within a single cell the renderer branches per value: addresses that
 * look like emails become <a href="mailto:..."> with a pencil to switch
 * to edit mode; non-matching values fall through to a plain text input.
 * The renderer name is `email` — pick it in the column editor's
 * Renderer dropdown.
 */

export const meta = {
  name: 'cell-email',
  version: '0.1.0',
  description:
    'Renders email-shaped values as mailto: links. Apply by setting a column\'s renderer to "email".',
  author: 'easyDBAccess reference',
};

export function init(api) {
  if (!customElements.get('cell-email')) {
    customElements.define('cell-email', CellEmail);
  }
  api.ui.registerCellRenderer('email', 'cell-email');
}

class CellEmail extends HTMLElement {
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
    const email = !this._editing ? detectEmail(v) : null;

    if (email) {
      const wrap = document.createElement('span');
      wrap.style.cssText = 'display:inline-flex;align-items:center;gap:0.25rem;width:100%';

      const a = document.createElement('a');
      a.href = `mailto:${email}`;
      a.textContent = email;
      a.title = `Email ${email}`;
      a.style.cssText =
        'color:#2563eb;text-decoration:underline;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';

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
      input.placeholder = 'email address';
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

/**
 * Lightweight RFC-5322-inspired check: local-part allows the common
 * unreserved characters (letters, digits, dot, underscore, plus, percent,
 * hyphen); domain requires at least one dot and a 2+ character TLD. Not
 * a full parser, but it rejects obvious non-addresses without false
 * negatives on typical user-facing inputs.
 */
function detectEmail(s) {
  const t = String(s).trim();
  if (!t) return null;
  if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(t)) return null;
  return t;
}
