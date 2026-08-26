// packages/renderer/src/window-mgr/color-button.ts
//
// The palette button in a window's titlebar, and the swatch grid it opens.
//
// One builder for every kind of window — a table, a view, a visualization — so
// the control is in the same place and behaves the same way whatever the window
// holds. It follows the (i) info button's shape (`table-window-manager`): a plain
// button prepended to `.jsPanel-controlbar`, inline-styled, because the titlebar
// is light DOM built by `createPanel` and has no stylesheet for extras.
//
// NOT `AnchoredMenu`, which every other dropdown in the app uses. Its `icon` is a
// Material Icons LIGATURE rendered as text in one colour — so a swatch handed to
// it comes out as the literal string `<svg …>` in the menu, and even a ligature
// would paint every entry the same grey. A colour picker whose entries are names
// is not a colour picker.
//
// The panel is a native `popover="auto"`, like every other transient layer here
// (see the popover note in the root CLAUDE.md): the browser owns the top layer
// and the light dismiss, so there is no z-index race with the canvas and no
// outside-click listener to leak.
//
// Window management is core and plugins do not touch it, which is why this lives
// here rather than in a plugin: there is no registry for a titlebar button yet.
// Everything a plugin WOULD need is already separated out — the colour list and
// the two store calls are in `window-color.ts`.

import { choiceForColor, PALETTE_ICON, WINDOW_COLORS } from './window-color.js';

export interface ColorButtonOptions {
  /** The override in force now, or null while the window follows its kind. */
  current(): string | null;
  /** Called with the new override, or null for "follow the kind again". */
  onPick(color: string | null): void | Promise<void>;
}

/** Distance between the button and the panel it opens. */
const GAP = 4;

/**
 * Build the button. The caller prepends it to the controlbar and owns its
 * lifetime — the panel's own teardown takes it with the titlebar.
 */
export function createColorButton(opts: ColorButtonOptions): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.title = 'Window colour';
  btn.setAttribute('aria-label', 'Window colour');
  btn.className = 'eda-color-btn';
  btn.innerHTML = PALETTE_ICON;
  btn.style.cssText = 'display:inline-flex;align-items:center;background:none;border:0;color:inherit;cursor:pointer;padding:0 0.3rem;line-height:1;';
  btn.addEventListener('click', (e) => {
    // The titlebar is a drag handle and a double-click target. Without this the
    // click that opens the picker also starts a drag of the window behind it.
    e.stopPropagation();
    openPicker(btn, opts);
  });
  return btn;
}

function openPicker(btn: HTMLButtonElement, opts: ColorButtonOptions): void {
  const chosen = choiceForColor(opts.current());
  const pop = document.createElement('div');
  pop.className = 'eda-color-pop';
  pop.setAttribute('popover', 'auto');
  pop.setAttribute('role', 'menu');
  pop.setAttribute('aria-label', 'Window colour');
  pop.style.cssText = [
    'position:fixed;margin:0;padding:0.4rem;inset:auto',
    'border:1px solid #d1d5db;border-radius:0.4rem;background:#fff',
    'box-shadow:0 8px 24px rgb(0 0 0 / 18%)',
    'display:grid;grid-template-columns:repeat(3, auto);gap:0.25rem',
    'font:13px/1.2 system-ui, sans-serif;color:#111827',
  ].join(';');

  for (const c of WINDOW_COLORS) {
    pop.append(swatchButton(c, c.id === chosen, pop, opts));
  }

  document.body.append(pop);
  // Removed on close rather than kept and reused: the picker is opened rarely,
  // and a live element per window would outlive the windows themselves.
  pop.addEventListener('toggle', (e) => {
    if ((e as ToggleEvent).newState === 'closed') pop.remove();
  });
  pop.showPopover();
  place(pop, btn.getBoundingClientRect());
}

/**
 * One swatch. The colour is the button, and the NAME is its accessible label —
 * so the control is usable by someone who cannot see the colour, and testable
 * without reading pixels.
 */
function swatchButton(c: (typeof WINDOW_COLORS)[number], isCurrent: boolean, pop: HTMLElement, opts: ColorButtonOptions): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'menuitemradio');
  b.setAttribute('aria-checked', String(isCurrent));
  b.setAttribute('aria-label', c.label);
  b.title = c.label;
  b.dataset['color'] = c.id;
  b.style.cssText = [
    'width:2rem;height:2rem;border-radius:0.3rem;cursor:pointer;padding:0',
    'display:flex;align-items:center;justify-content:center',
    `background:${c.value ?? 'transparent'}`,
    // The current one is ringed rather than ticked: a tick drawn over a dark
    // swatch needs a colour of its own, and the ring reads at swatch size.
    isCurrent ? 'border:2px solid #111827' : 'border:1px solid #d1d5db',
    // The default entry has no colour to show, so it says so in words.
    c.value ? '' : 'font-size:11px;color:#6b7280;line-height:1.05;text-align:center',
  ]
    .filter(Boolean)
    .join(';');
  if (!c.value) b.textContent = 'Kind';
  b.addEventListener('click', () => {
    pop.hidePopover();
    void opts.onPick(c.value);
  });
  return b;
}

/**
 * Put the panel under the button, pulled back inside the viewport.
 *
 * Measured after `showPopover`, because a popover has no size until the browser
 * has put it in the top layer. Fixed coordinates, so the canvas pan/zoom under
 * it does not apply — the button's rect is already in viewport space.
 */
function place(pop: HTMLElement, anchor: DOMRect): void {
  const box = pop.getBoundingClientRect();
  const left = Math.max(GAP, Math.min(anchor.left, window.innerWidth - box.width - GAP));
  const below = anchor.bottom + GAP;
  const top = below + box.height > window.innerHeight ? Math.max(GAP, anchor.top - box.height - GAP) : below;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}
