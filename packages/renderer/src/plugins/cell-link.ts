import type { HostApi, PluginModule } from '@easydb/shared';

export const meta: NonNullable<PluginModule['meta']> = {
  id: 'cell-link',
  name: 'Cell Link',
  type: 'cell-renderer',
  version: '0.2.0',
  description:
    'Renderer for URL/email/phone cells. Inside a single cell, http(s) URLs render as <a target=_blank>, email addresses as <a href=mailto:>, phone-like values as <a href=tel:>, anything else falls back to a text input. A pencil toggles to edit mode.',
  author: 'Marc Cawood',
  icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  repo: 'https://github.com/cawoodm/easydbaccess/blob/main/packages/renderer/src/plugins/cell-link.ts',
};

/**
 * Built-in cell renderer for "link" columns. Columns opt in by setting
 * `renderer: 'link'`; the type of the column stays whatever the user picked
 * (usually 'string'). Per-value branching inside the cell is preserved from
 * the pre-rewrite implementation — the renderer is set per column, but the
 * URL/email/phone detection is per value.
 */
export function init(api: HostApi): void {
  if (!customElements.get('cell-link')) {
    customElements.define('cell-link', CellLink);
  }
  api.ui.registerCellRenderer('link', 'cell-link');
}

class CellLink extends HTMLElement {
  private _value = '';
  private _editing = false;
  /**
   * The input currently allowed to commit. Removing a focused input makes the
   * browser fire `blur` (and sometimes `change`) on it while it still looks
   * connected, so identity — not liveness — is what decides whether an event
   * belongs to the live editor. Escape clears this first, which is what stops a
   * cancelled edit from being saved by its own trailing blur.
   */
  private _editor: HTMLInputElement | null = null;

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
    // Fill the cell as a shrinkable block so the link inside can ellipsize to
    // whatever width the column currently has (see the anchor styles below).
    this.style.display = 'block';
    this.style.minWidth = '0';
    this.style.maxWidth = '100%';
    this.style.overflow = 'hidden';
    this.render();
  }

  private render() {
    this.innerHTML = '';
    // Any editor from a previous paint is dead the moment we wipe the DOM.
    this._editor = null;
    const v = this._value;
    // Priority: URL → email → phone. Email and URL never collide (no '@' in
    // an http URL host that's also bare), but URLs are still checked first
    // because http(s)://… is the unambiguous winner. Phone last because its
    // shape (digits + separators) overlaps least with the other two.
    const url = !this._editing ? detectUrl(v) : null;
    const email = !this._editing && !url ? detectEmail(v) : null;
    const tel = !this._editing && !url && !email ? detectPhone(v) : null;

    if (url || email || tel) {
      const wrap = document.createElement('span');
      wrap.style.cssText =
        'display:flex;align-items:center;gap:0.25rem;width:100%;min-width:0;max-width:100%';
      const a = document.createElement('a');
      a.href = url ? v : email ? `mailto:${v.trim()}` : `tel:${v.replace(/[^\d+]/g, '')}`;
      if (url) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      a.textContent = v;
      // Ellipsize to the space the column gives us: as a `min-width:0` flex
      // child the anchor shrinks below its content width, so the browser
      // truncates it with an ellipsis at whatever the current column width is —
      // purely in CSS, and it re-flows live as the column is resized. The full
      // value stays in the title tooltip.
      a.style.cssText =
        'flex:1 1 auto;min-width:0;display:block;color:#2563eb;text-decoration:underline;' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      a.title = url ? `Open ${v}` : email ? `Email ${v}` : `Call ${v}`;

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.title = 'Edit';
      edit.textContent = '✎';
      edit.style.cssText =
        'flex:none;background:transparent;border:0;cursor:pointer;color:#9ca3af;font-size:0.85em;padding:0 0.15rem;line-height:1';
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
      input.addEventListener('change', () => {
        if (this._editor !== input) return;
        this.commit(input.value);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.commit(input.value);
        } else if (e.key === 'Escape') {
          // Disown this input first: render() removes it, which fires blur, and
          // that blur must not save the edit we are cancelling.
          this._editor = null;
          this._editing = false;
          this.render();
        }
      });
      // Losing focus must leave edit mode, so a value that has BECOME a link
      // renders as one straight away. `change` only fires when the value
      // actually changed, so an unchanged field would otherwise stay an input
      // forever (the pencil had no way back).
      input.addEventListener('blur', () => {
        // Only the LIVE editor may commit — see `_editor`.
        if (this._editor !== input) return;
        this.commit(input.value);
      });
      this.append(input);
      this._editor = input;
      if (this._editing) {
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);
      }
    }
  }

  private commit(v: string) {
    const changed = v !== this._value;
    this._value = v;
    this._editing = false;
    // Re-render on our own. The host writes the stored value back through the
    // `value` setter, but that setter early-returns when the value is unchanged
    // — and we just assigned it — so nothing would repaint: a cell where you
    // typed a URL stayed an <input> instead of becoming a link.
    this.render();
    if (!changed) return;
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
 * Email-shape detector. Pragmatic check (not RFC-5322) — a single `@`, a
 * non-empty local part with no whitespace, a host with at least one dot,
 * and a TLD of 2+ letters. Tight enough to reject phone numbers, dates,
 * and plain text; loose enough for any real-world address.
 */
function detectEmail(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z]{2,}$/.test(t)) return t;
  return null;
}

/**
 * Phone-shape detector. Accepts strings made of digits plus the usual
 * separators (+, space, parens, dot, hyphen) where the digit count falls in
 * the ITU E.164 range of 7–15. Conservative so we don't promote numeric IDs
 * or product codes into clickable phone links.
 */
function detectPhone(s: string): string | null {
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
