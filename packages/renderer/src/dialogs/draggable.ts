/**
 * Make a <dialog> draggable by one of its descendants (typically the
 * `.dialog-header` bar). Native <dialog> elements center themselves at
 * showModal() and can't be moved by the user. This wires pointer events
 * on the handle, captures the pointer for the duration of the drag, and
 * translates the dialog by the delta via inline `left`/`top`.
 *
 * Idempotent: re-invoking with the same handle is a no-op (a WeakSet keeps
 * track). Dialogs whose header DOM node is recreated by Lit on a template
 * switch will safely re-bind because the new node isn't in the set yet;
 * the old node's listeners are GC'd with the orphaned element.
 */
const boundHandles = new WeakSet<HTMLElement>();

export function makeDialogDraggable(dialog: HTMLDialogElement, handle: HTMLElement): void {
  if (boundHandles.has(handle)) return;
  boundHandles.add(handle);

  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let active = false;

  handle.style.cursor = 'grab';
  handle.style.touchAction = 'none';
  handle.style.userSelect = 'none';

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    // Skip drag if the click is on an interactive descendant — pointer
    // capture would otherwise swallow the click.
    const target = e.target as HTMLElement;
    if (target.closest('button, input, textarea, select, a, label')) return;
    active = true;
    startX = e.clientX;
    startY = e.clientY;
    const rect = dialog.getBoundingClientRect();
    baseX = rect.left;
    baseY = rect.top;
    handle.setPointerCapture(e.pointerId);
    handle.style.cursor = 'grabbing';
  });

  handle.addEventListener('pointermove', (e: PointerEvent) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // Keep at least 80px of the dialog inside the viewport so the user
    // can always grab it back.
    const minX = -dialog.offsetWidth + 80;
    const maxX = window.innerWidth - 80;
    const minY = 0;
    const maxY = window.innerHeight - 40;
    const nx = Math.max(minX, Math.min(maxX, baseX + dx));
    const ny = Math.max(minY, Math.min(maxY, baseY + dy));
    // <dialog> centers via margin: auto; explicit position overrides it.
    dialog.style.position = 'fixed';
    dialog.style.left = `${nx}px`;
    dialog.style.top = `${ny}px`;
    dialog.style.margin = '0';
  });

  const endDrag = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch {
      /* capture already released — happens on pointercancel */
    }
    handle.style.cursor = 'grab';
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}
