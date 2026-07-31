// "You have unsaved work" guard.
//
// A dialog that holds unsaved edits (the columns editor, the Settings dialog)
// registers a key here while it is dirty. As long as any key is registered, a
// `beforeunload` handler cancels the unload, so the browser asks before it
// leaves or reloads the page — including the automatic reload a dev server
// triggers on a file change, which used to wipe a half-finished column editor
// without a word.
//
// Keys are strings so two dialogs can be dirty at once and neither clears the
// other's flag.

const dirty = new Set<string>();
let installed = false;

/** True while at least one editor holds unsaved changes. */
export function isDirty(): boolean {
  return dirty.size > 0;
}

/** Registers `key` as holding unsaved changes. */
export function markDirty(key: string): void {
  dirty.add(key);
  install();
}

/** Clears `key` — its editor was saved, cancelled or closed. */
export function markClean(key: string): void {
  dirty.delete(key);
}

/**
 * Marks `key` dirty on any edit inside `dialog`, and clean again when it closes.
 *
 * One listener per dialog rather than a call in every field handler: `input` and
 * `change` bubble to the `<dialog>` from every control inside it, and both
 * dialogs close through `dialogEl.close()`, which fires `close` whether the user
 * saved or cancelled. A dialog that closes after a successful save is therefore
 * clean without the save path having to say so.
 *
 * Only an OPEN dialog can be dirty. Clicking Save/Done blurs the field the user
 * was typing in, and that blur fires a trailing `change` — after the `close`
 * event — which would otherwise re-arm the guard on a dialog that is already
 * gone.
 */
export function watchDialogDirty(key: string, dialog: HTMLDialogElement): void {
  const touch = () => {
    if (dialog.open) markDirty(key);
  };
  dialog.addEventListener('input', touch);
  dialog.addEventListener('change', touch);
  dialog.addEventListener('close', () => markClean(key));
}

/**
 * Installs the `beforeunload` handler once, on the first dirty editor. The
 * browser only shows its own confirm dialog when the page has been interacted
 * with, which by definition it has by the time anything is dirty.
 */
function install(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    if (!isDirty()) return;
    e.preventDefault();
    // Ignored by current browsers (they show their own wording) but still
    // required by older ones to make the prompt appear at all.
    e.returnValue = '';
  });
}
