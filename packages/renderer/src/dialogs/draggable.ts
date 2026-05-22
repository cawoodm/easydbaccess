/**
 * Make a <dialog> draggable by one of its descendants (typically a header).
 * Native <dialog> elements center themselves at showModal(); the user can't
 * move them. This wires a pointerdown on the handle that listens for
 * pointermove/up on the window and translates the dialog by the delta.
 *
 * Idempotent — calling twice on the same dialog/handle pair just re-binds.
 */
export function makeDialogDraggable(dialog: HTMLDialogElement, handle: HTMLElement): void {
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;
  let active = false;

  const onDown = (e: PointerEvent) => {
    // Don't start a drag if the user clicked an interactive child of the
    // handle (button, input, select). Pointer captures interfere with click.
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
  };

  const onMove = (e: PointerEvent) => {
    if (!active) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const minX = -dialog.offsetWidth + 80; // keep at least 80px on-screen
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
  };

  const onUp = (e: PointerEvent) => {
    if (!active) return;
    active = false;
    handle.releasePointerCapture(e.pointerId);
    handle.style.cursor = 'grab';
  };

  // Replace any existing listeners (defensive against double-binding).
  handle.removeEventListener('pointerdown', onDown);
  handle.removeEventListener('pointermove', onMove);
  handle.removeEventListener('pointerup', onUp);
  handle.removeEventListener('pointercancel', onUp);
  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.style.cursor = 'grab';
  handle.style.touchAction = 'none';
}
