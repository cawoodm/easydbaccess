// packages/renderer/src/viz/dock-icons.ts
//
// The pop-out / pop-in pair, as one icon and its reverse.
//
// Popping a chart out of the grid and docking it back are one gesture and its
// opposite, so they have to LOOK like one gesture and its opposite. Pop-out has
// always been Material's `open_in_new`: a square frame open at its top-right
// corner, with a diagonal arrow leaving through that opening. Pop-in had no
// matching glyph — the icon font has no mirrored `open_in_new` — so it borrowed
// `south_west`, a bare arrow with no frame at all. The pair read as two
// unrelated buttons.
//
// So the frame is drawn once here and the arrow twice: out, and the same arrow
// reversed. `FRAME` and `ARROW_OUT` are Material's own `open_in_new` paths,
// verbatim, which is why the pop-out button looks exactly as it always did.
//
// `ARROW_IN` is `ARROW_OUT` rotated 180° about the centre of its own bounding
// box — same shaft along the same diagonal, same corner arrowhead, pointing the
// other way. Rotating it about the centre of the ICON instead (or just putting
// `transform: rotate(180deg)` on the glyph) would have swung the arrow round to
// the bottom-left, where the frame is solid: the arrowhead would land on top of
// the frame's own corner and still read as leaving. Rotating it about its own
// centre keeps it on the open diagonal, so the arrow comes IN through the gap
// the frame leaves and stops in the middle of the box.
//
// Hence the decimals. They are the rotation, not sloppiness — the arrowhead
// corner lands at (7.76, 16.24) rather than on the 1px grid, and rounding it to
// whole units shortens the shaft and pulls the head off the diagonal.

import { css, html } from 'lit';

/** The square frame, open at the top-right corner. Material `open_in_new`. */
const FRAME = 'M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z';

/** Leaving: arrowhead outside, at the top-right. Material `open_in_new`. */
const ARROW_OUT = 'M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z';

/** Arriving: the same arrow turned 180° about its own centre — head inside. */
const ARROW_IN = 'M14.76 16.24v-2H11.17l9.83-9.83-1.41-1.41L9.76 12.83V9.24H7.76v7h7z';

/**
 * Sized to match `.mi.sm` (1rem) so an SVG icon sits in a row of font icons
 * without nudging the others. `currentColor` for the same reason a ligature
 * needs no colour rule: the button already has one.
 */
export const dockIconStyles = css`
  .dock-icon {
    width: 1rem;
    height: 1rem;
    display: inline-block;
    vertical-align: middle;
    fill: currentColor;
  }
`;

/** Pop out — open this in its own window. */
export const popOutIcon = html`<svg class="dock-icon" viewBox="0 0 24 24" aria-hidden="true">
  <path d=${FRAME}></path>
  <path d=${ARROW_OUT}></path>
</svg>`;

/** Pop in — dock this back above its table. */
export const popInIcon = html`<svg class="dock-icon" viewBox="0 0 24 24" aria-hidden="true">
  <path d=${FRAME}></path>
  <path d=${ARROW_IN}></path>
</svg>`;
