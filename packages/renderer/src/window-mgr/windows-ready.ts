// packages/renderer/src/window-mgr/windows-ready.ts
//
// "Are the restored windows on screen yet?" as a promise.
//
// `app:ready` is NOT that moment: it is emitted from a microtask inside
// `app-context.init()`, while the window managers are started later by
// `chrome/table-list.ts`'s `connectedCallback`. Anything that wants to act on a
// table's WINDOW at boot — a `?cmdlet=` deep link, a `#hash` — has to wait for
// this instead, or it reveals a panel that does not exist yet.
//
// A promise rather than an event so a late listener still resolves: whoever
// asks after the fact gets an already-settled promise instead of waiting
// forever for an event that has been and gone.

let resolveReady: () => void;
const ready = new Promise<void>((resolve) => {
  resolveReady = resolve;
});

/** Called once by `table-list.ts` after both window managers have started. */
export function markWindowsReady(): void {
  resolveReady();
}

/** Resolves when the restored table and view windows are on screen. */
export function whenWindowsReady(): Promise<void> {
  return ready;
}
