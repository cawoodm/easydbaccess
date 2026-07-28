/**
 * The shared "edit this cell anyway" affordance.
 *
 * A display-only renderer replaces the cell's content, which leaves the stored
 * value unreachable — a script-rendered or image cell had no editor at all. Each
 * such renderer offers a small gray pencil pinned to the cell's right edge that
 * swaps in a raw-value editor; committing re-renders, so the cell goes straight
 * back to its rendered form.
 *
 * Kept in one place so the pencil looks and behaves identically in every
 * renderer (`cell-link` was the original, `cell-script` and `cell-image`
 * followed).
 */

/**
 * A pencil button that sits at the far right of a cell row. `flex: none` keeps
 * it at its natural size next to a `flex: 1` content element — see `pencilRow`.
 */
export function makePencil(onClick: () => void, title = 'Edit'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = title;
  btn.textContent = '✎';
  btn.className = 'cell-pencil';
  btn.style.cssText =
    'flex:none;background:transparent;border:0;cursor:pointer;color:#9ca3af;' +
    'font-size:0.85em;padding:0 0.15rem;line-height:1';
  btn.addEventListener('mouseenter', () => (btn.style.color = '#374151'));
  btn.addEventListener('mouseleave', () => (btn.style.color = '#9ca3af'));
  btn.addEventListener('click', (e) => {
    // The cell itself may react to clicks (open a window, follow a link); the
    // pencil is a separate action, so it must not bubble into that.
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  return btn;
}

/**
 * Lay `content` out with `trailing` (normally a pencil) pinned right. The
 * content gets `min-width: 0` so it can shrink — and therefore ellipsize —
 * instead of pushing the pencil out of a narrow column.
 */
export function pencilRow(content: HTMLElement, trailing: HTMLElement): HTMLElement {
  const row = document.createElement('span');
  row.style.cssText =
    'display:flex;align-items:center;gap:0.25rem;width:100%;min-width:0;max-width:100%';
  content.style.flex = '1 1 auto';
  content.style.minWidth = '0';
  content.style.overflow = 'hidden';
  row.append(content, trailing);
  return row;
}

/**
 * A raw-value text editor for a cell whose renderer normally hides that value.
 *
 * `onCommit` fires on Enter and on losing focus; Escape calls `onCancel`. Only
 * the live input may commit: re-rendering removes a focused input, and the
 * browser fires `blur` on it while it still reads as connected, so a cancelled
 * edit would otherwise be saved by its own trailing blur. `isLive` lets the
 * caller answer "is this still the editor you're showing?".
 */
export function makeValueEditor(opts: {
  value: string;
  onCommit: (v: string) => void;
  onCancel: () => void;
  isLive: (input: HTMLInputElement) => boolean;
}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = opts.value;
  input.style.cssText =
    'width:100%;box-sizing:border-box;border:0;background:transparent;font:inherit;' +
    'padding:0;text-overflow:ellipsis';
  const commit = () => {
    if (!opts.isLive(input)) return;
    opts.onCommit(input.value);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      opts.onCancel();
    }
  });
  input.addEventListener('blur', commit);
  // Focus after the caller has appended it (a detached input can't take focus).
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return input;
}
