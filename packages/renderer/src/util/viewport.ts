// packages/renderer/src/util/viewport.ts
//
// The app's ONE mobile breakpoint, in a form JavaScript can ask about.
//
// The chrome has always known about narrow screens through CSS — `app-shell`
// wraps its header, `dialog-chrome` goes full-width, `projection-dialog`
// stacks its grid — all at `@media (max-width: 640px)`. Some decisions cannot
// be made in CSS, though: a floating panel's opening SIZE and STATE are set in
// script when the panel is created. Those need the same number, and a second
// hard-coded 640 somewhere else is how the two quietly drift apart.
//
// So the number lives here once. If it changes, the `@media (max-width: 640px)`
// blocks change with it.

/** Widths at or below this are "mobile" — matches the CSS `@media` blocks. */
export const MOBILE_MAX_WIDTH = 640;

/**
 * True on a narrow (phone-sized) viewport.
 *
 * Deliberately a width test, not a user-agent or touch test: what makes a
 * 520×400 floating window unusable is that it does not fit, and a narrow
 * desktop window has exactly the same problem as a phone. `matchMedia` is the
 * same engine that drives the CSS, so the two never disagree; the
 * `innerWidth` fallback is for test environments that stub it out.
 */
export function isMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof window.matchMedia === 'function') {
    return window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH}px)`).matches;
  }
  return window.innerWidth <= MOBILE_MAX_WIDTH;
}
