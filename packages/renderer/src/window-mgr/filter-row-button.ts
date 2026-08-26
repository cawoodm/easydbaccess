// packages/renderer/src/window-mgr/filter-row-button.ts
//
// The funnel in a table window's titlebar: show or hide the filter row — the
// boxes under the column headers.
//
// Same shape as `color-button.ts` and the (i) info button: a plain button
// prepended to `.jsPanel-controlbar`, inline-styled, because the titlebar is
// light DOM built by `createPanel` and has no stylesheet for extras.
//
// It is a titlebar control rather than a footer one because the filter row is
// window furniture: it belongs with maximize and close, not with the actions
// that operate on the data. And it is per WINDOW because that is where the need
// is — a lookup table of twelve rows never needs the boxes, while the
// 600,000-row table beside it always does.

/** Funnel, and funnel struck through. Two frames of the same glyph, so the
 *  state reads without colour — a screenshot in grey still says which it is. */
const FUNNEL =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8Z"/></svg>';
const FUNNEL_OFF =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18l-7 8v6l-4 2v-8Z"/><path d="M4 20 20 4"/></svg>';

export interface FilterRowButtonOptions {
  /** Is the filter row on screen right now? */
  shown(): boolean;
  /** Called with the state the user asked for. */
  onToggle(next: boolean): void | Promise<void>;
}

/**
 * Build the button. The caller prepends it to the controlbar and owns its
 * lifetime — the panel's own teardown takes it with the titlebar.
 *
 * `refresh` is returned rather than the button re-reading `shown()` on a timer:
 * the state can change from elsewhere (another device's sync, a second window on
 * the same table), and the manager already has the subscription that knows.
 */
export function createFilterRowButton(opts: FilterRowButtonOptions): { el: HTMLButtonElement; refresh(): void } {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'eda-filter-row-btn';
  btn.style.cssText = 'display:inline-flex;align-items:center;background:none;border:0;color:inherit;cursor:pointer;padding:0 0.3rem;line-height:1;';

  const refresh = (): void => {
    const on = opts.shown();
    // The label says what the click DOES, not what the state is: a titlebar
    // button is read on the way to pressing it.
    const title = on ? 'Hide the filter row' : 'Show the filter row';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML = on ? FUNNEL : FUNNEL_OFF;
    // Dimmed while off, so a glance at a row of windows says which are which.
    btn.style.opacity = on ? '1' : '0.55';
  };
  refresh();

  btn.addEventListener('click', (e) => {
    // The titlebar is a drag handle and a double-click target. Without this the
    // click that toggles the row also starts a drag of the window behind it.
    e.stopPropagation();
    void opts.onToggle(!opts.shown());
  });
  return { el: btn, refresh };
}
