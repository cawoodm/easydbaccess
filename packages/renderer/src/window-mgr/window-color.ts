// packages/renderer/src/window-mgr/window-color.ts
//
// A window's own titlebar colour, chosen by the user, overriding the one its
// KIND would give it.
//
// The automatic colour says what a window is: every table is a shade of blue,
// a view is teal, a visualization violet (`table-kind.ts`, `view-window-manager.ts`).
// That is worth keeping as the default and worth being able to override, because
// what a window IS stops being the useful distinction once a workspace holds
// fifteen tables and you are looking for one of them.
//
// So an override is a per-window choice, and only that: nothing reads it back to
// infer a kind, and clearing it returns the window to its kind's colour rather
// than to a stored "normal".
//
// Stored in the `settings` collection under one key per window, NOT on the
// `Table` / `ViewInstance` record beside `windowGeometry`. Two reasons: it needs
// no change to the stored shape of a table, and a settings key is reachable by a
// plugin, which the titlebar itself is not yet. The colour is workspace-scoped
// either way, so it travels with the workspace like the window layout does.
//
// Pure, apart from the two store calls at the bottom.

import type { DataStore } from '@easydb/shared';

/** One key per window: `window-color:<table or view instance id>`. */
const PREFIX = 'window-color:';

export function windowColorKey(windowId: string): string {
  return `${PREFIX}${windowId}`;
}

/** One offerable colour. `value: null` is "whatever this window's kind says". */
export interface WindowColorChoice {
  id: string;
  label: string;
  value: string | null;
}

/**
 * What the picker offers when the user has not said otherwise — the SHIPPED
 * list. `windowColors()` is what the picker actually reads, and the setting
 * `windows:colors` is what fills it (see `window-color-settings.ts`).
 *
 * Deliberately a short list of distinct HUES rather than a full colour wheel. The
 * point of an override is to tell two windows apart at a glance across a zoomed-
 * out canvas, and a free colour picker mostly produces neighbouring shades that
 * fail at exactly that. Every value clears WCAG AA against the white titlebar
 * text, which is the same rule the kind palette holds itself to — a titlebar the
 * user cannot read is not a customization.
 *
 * The kind blues are NOT offered. Painting a view in table-blue would make the
 * one thing the automatic colour still says come out wrong.
 */
export const WINDOW_COLORS: readonly WindowColorChoice[] = [
  { id: 'default', label: 'Default for this kind', value: null },
  { id: 'slate', label: 'Slate', value: '#334155' },
  { id: 'teal', label: 'Teal', value: '#0f766e' },
  { id: 'green', label: 'Green', value: '#15803d' },
  { id: 'olive', label: 'Olive', value: '#4d7c0f' },
  { id: 'amber', label: 'Amber', value: '#b45309' },
  { id: 'red', label: 'Red', value: '#b91c1c' },
  { id: 'pink', label: 'Pink', value: '#a21caf' },
  { id: 'violet', label: 'Violet', value: '#6d28d9' },
];

/** The shipped list as the setting's text, so the field opens on what it does. */
export const DEFAULT_WINDOW_COLOR_LIST = WINDOW_COLORS.filter((c) => c.value)
  .map((c) => c.value)
  .join(',');

/**
 * The list in force. Module state, set once at boot from the setting and again
 * when it changes — the picker is built inside a click handler and the settings
 * read is async, the same shape as `util/link-settings.ts`.
 */
let liveColors: readonly WindowColorChoice[] = WINDOW_COLORS;

/** What the picker offers right now. */
export function windowColors(): readonly WindowColorChoice[] {
  return liveColors;
}

/** Replace the list. `null` puts the shipped one back. */
export function setWindowColors(colors: readonly WindowColorChoice[] | null): void {
  liveColors = colors && colors.length > 1 ? colors : WINDOW_COLORS;
}

/**
 * The CSS named colours, which is what "an HTML colour value" means to a user
 * writing `red` instead of `#f00`.
 *
 * Spelled out rather than asked of the browser (`CSS.supports('color', v)`),
 * because this module is pure and unit-tested under Node, where `CSS` does not
 * exist. A rule that answered differently in a test and in the app would be
 * worse than the 148 names it saves.
 *
 * `transparent` and `currentColor` are deliberately absent, along with the
 * keywords that mean "whatever the parent says": each paints a swatch the user
 * cannot see and a titlebar that looks broken rather than coloured.
 */
const CSS_COLOR_NAMES = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood ' +
    'cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod ' +
    'darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon ' +
    'darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray ' +
    'dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon ' +
    'lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon ' +
    'lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue ' +
    'mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy ' +
    'oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip ' +
    'peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal ' +
    'thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Is this a colour a titlebar can be painted with? A hex value or a CSS name. */
export function isWindowColor(value: string): boolean {
  const v = value.trim();
  if (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return true;
  return CSS_COLOR_NAMES.has(v.toLowerCase());
}

/** Split the setting's text. Commas, spaces and new lines all separate. */
function splitList(raw: string): string[] {
  return raw
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/**
 * Turn the setting's text into the list the picker offers.
 *
 * Anything that is not a colour is DROPPED rather than refused: the field is one
 * line of text and a typo in the middle of it must not cost the user the other
 * eight colours. An empty setting — or one holding nothing usable at all — gives
 * the shipped list back, so there is no way to end up with a picker that offers
 * only "Kind".
 *
 * A shipped colour keeps its shipped name and id wherever it appears in the
 * user's list, so `#15803d` is still "Green" and a window already painted with it
 * still shows as the current one.
 */
export function parseWindowColors(raw: string | null | undefined): readonly WindowColorChoice[] {
  const entries = typeof raw === 'string' ? splitList(raw) : [];
  const out: WindowColorChoice[] = [WINDOW_COLORS[0]!];
  const seenValue = new Set<string>();
  const usedId = new Set<string>([WINDOW_COLORS[0]!.id]);
  for (const value of entries) {
    if (!isWindowColor(value)) continue;
    const key = value.toLowerCase();
    if (seenValue.has(key)) continue;
    seenValue.add(key);
    const shipped = WINDOW_COLORS.find((c) => c.value?.toLowerCase() === key);
    const label = shipped ? shipped.label : key.startsWith('#') ? value.toUpperCase() : capitalize(value);
    let id = shipped ? shipped.id : key.replace(/^#/, '');
    for (let n = 2; usedId.has(id); n++) id = `${key.replace(/^#/, '')}-${n}`;
    usedId.add(id);
    out.push({ id, label, value });
  }
  return out.length > 1 ? out : WINDOW_COLORS;
}

/** The colour a menu id means, or `undefined` for an id nothing offers. */
export function colorForChoice(id: string): string | null | undefined {
  const found = windowColors().find((c) => c.id === id);
  return found ? found.value : undefined;
}

/** The choice a stored value corresponds to, for ticking the current one. */
export function choiceForColor(color: string | null | undefined): string {
  if (!color) return 'default';
  const found = windowColors().find((c) => c.value?.toLowerCase() === color.toLowerCase());
  return found ? found.id : 'custom';
}

/** The palette glyph on the titlebar button. */
export const PALETTE_ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" role="img" aria-hidden="true">' +
  '<path d="M12 21a9 9 0 1 1 9-9c0 2-1.6 3-3 3h-1.5a2 2 0 0 0-1.3 3.5A1.6 1.6 0 0 1 12 21Z"/>' +
  '<circle cx="8" cy="9.5" r="1.1" fill="currentColor" stroke="none"/>' +
  '<circle cx="12" cy="7" r="1.1" fill="currentColor" stroke="none"/>' +
  '<circle cx="16" cy="9.5" r="1.1" fill="currentColor" stroke="none"/>' +
  '</svg>';

/** This window's stored override, or null when it has none. */
export async function readWindowColor(store: DataStore, windowId: string): Promise<string | null> {
  try {
    const rec = await store.settings.findOne(windowColorKey(windowId));
    const value = (rec as { value?: unknown } | null | undefined)?.value;
    return typeof value === 'string' && value.trim() ? value : null;
  } catch {
    // A colour is not worth failing to open a window over.
    return null;
  }
}

/**
 * Write the override, or remove it for the default.
 *
 * The default is stored as an ABSENT key rather than an empty string, so "this
 * window follows its kind" cannot drift apart from "nobody has chosen yet" — the
 * two are the same state and there is no way to tell them apart usefully.
 */
export async function writeWindowColor(store: DataStore, windowId: string, color: string | null): Promise<void> {
  const name = windowColorKey(windowId);
  if (color) await store.settings.upsert({ name, value: color });
  else await store.settings.remove(name);
}
