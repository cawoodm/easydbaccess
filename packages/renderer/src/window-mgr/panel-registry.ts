/**
 * Cross-manager panel lookup for the global restack pass (`restack.ts`).
 *
 * Table windows (`jspanel-manager.ts`) and view windows
 * (`view-window-manager.ts`) each register/unregister their jsPanel's
 * `front()` here as panels open/close, so the restack can front both kinds
 * without the two managers importing each other (they're deliberately kept
 * separate — see the header comment in `view-window-manager.ts`).
 *
 * What each manager MUST register is the *silent* front —
 * `panel.front(undefined, false)`. jsPanel's signature is
 * `front(callback, execOnFrontedCallbacks = true)`, and the second argument
 * gates the `onfronted` callbacks; `onfronted` is what stamps a NEW front rank
 * into the stored geometry (`stampFrontOrder` / `stampViewFrontOrder`). A
 * restack must not stamp: the saved `z` is the restack's INPUT, so re-deriving
 * it from the restack is circular, and it would rewrite `z` + `updatedAt` for
 * every window on every boot — churning the store and, with auto-sync/gist on,
 * pushing the whole workspace after each page load (and letting two devices
 * ping-pong geometry). A user click still fronts through jsPanel normally and
 * still stamps.
 */
type FrontFn = () => void;

const registry = new Map<string, FrontFn>();

export function registerPanel(id: string, front: FrontFn): void {
  registry.set(id, front);
}

export function unregisterPanel(id: string): void {
  registry.delete(id);
}

/** Whether a panel is currently registered — used to detect panels that
 * haven't finished opening yet (liveQuery opens them asynchronously). */
export function hasPanel(id: string): boolean {
  return registry.has(id);
}

/** Front a registered panel; silently ignored if it's gone or errors mid-restack. */
export function frontPanel(id: string): void {
  try {
    registry.get(id)?.();
  } catch {
    /* panel closed mid-restack */
  }
}
