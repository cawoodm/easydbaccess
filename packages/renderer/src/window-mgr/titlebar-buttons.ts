// packages/renderer/src/window-mgr/titlebar-buttons.ts
//
// Which buttons a window's titlebar offers, so Settings can offer a switch per
// button the way it already does for the header and footer bars.
//
// Those two get their lists from the plugin registries, because what is in them
// depends on which plugins loaded. A titlebar's buttons do not: window
// management is core and plugins do not touch it, so the list is a constant. It
// still has to BE a list rather than a set of scattered `createX` calls, because
// Settings has to name each one to offer a switch for it — and a switch for a
// button nobody can name is not a switch.
//
// The storage is deliberately the two bars' own: `show:<slot>:<id>` in the
// `chrome` settings namespace (see `chrome/chrome-settings.ts`). One vocabulary
// for "this button is off", whichever bar it is in.

/**
 * A button Settings can name. Deliberately NOT `ButtonSpec`: that carries a
 * required `onClick`, and these buttons are not invoked through this list — each
 * window manager builds and wires its own. A shape with a dummy handler in it
 * would be a lie about how the button runs.
 */
export interface TitlebarButtonSpec {
  id: string;
  label: string;
  tooltip?: string;
}

/** The titlebar buttons, in the order Settings lists them. */
export const TITLEBAR_BUTTONS: TitlebarButtonSpec[] = [
  {
    id: 'filter-row',
    label: 'Filter row',
    tooltip: 'The funnel in a table window’s titlebar, which shows and hides the filter boxes under the column headers.',
  },
  {
    id: 'window-color',
    label: 'Window colour',
    tooltip: 'The palette in a window’s titlebar, which gives that one window a colour of your own.',
  },
];

/** Every titlebar button id, for the settings reader. */
export const TITLEBAR_BUTTON_IDS: readonly string[] = TITLEBAR_BUTTONS.map((b) => b.id);
