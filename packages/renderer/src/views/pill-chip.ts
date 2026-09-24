// packages/renderer/src/views/pill-chip.ts
//
// The field=value filter CHIP: class names, operator glyphs and the CSS that
// draws them. One definition for the two renderings that now mean the same
// thing — the header's Lit chip (`view-window.ts`'s `renderPillChips`) and a
// body pill's string emitter (`view-render.ts`'s `renderFilterPill`) — so a
// value reads the same "on / excluded / not filtered" wherever it is shown.
// Before this the two were hand-synchronised copies (and a third lived in
// `viz/viz-tokens.ts`); see the note there for why that one does NOT import
// this module's two-part shape.
//
// A chip states one thing about one (field, value) pair — never touching the
// OTHER values OR-ed onto the same field, which is what lets several of them
// live side by side on one column. Three states, named once so every caller
// reads the same words:
//
//  - `on`  — this exact value is the filter (`field =`).
//  - `not` — this exact value is EXCLUDED (`field ≠`) — the other half of a
//    filter reached by clicking a value, unreachable before chips existed.
//  - `off` — nothing is filtering on this value. The field half is still
//    clickable — that click is what ADDS the filter — but shows no operator,
//    since none is in force yet.
//
// Pure: no DOM, no store. `pillChipClass` / `pillFieldLabel` are unit-tested
// alongside `view-render.ts`'s pure helpers.

import { css } from 'lit';

/** What a chip says about one (field, value) pair. See the file header. */
export type PillValueState = 'on' | 'not' | 'off';

export const PILL_CHIP_CLASS = 'eda-pill-chip';
export const PILL_CHIP_FIELD_CLASS = 'eda-pill-chip-field';
export const PILL_CHIP_VALUE_CLASS = 'eda-pill-chip-value';
export const PILL_CHIP_REMOVE_CLASS = 'eda-pill-chip-remove';
export const PILL_CHIP_OFF_CLASS = 'off';
export const PILL_CHIP_NOT_CLASS = 'not';

export const PILL_OP_EQ = '=';
export const PILL_OP_NOT_EQ = '≠';

/**
 * The chip's outer class list for one state: `eda-pill-chip`, plus `off`
 * (dashed, quiet — an offer rather than an active filter) or `not` (red —
 * an excluded value reads as excluded at a glance, not only by its ≠).
 */
export function pillChipClass(state: PillValueState): string {
  if (state === 'off') return `${PILL_CHIP_CLASS} ${PILL_CHIP_OFF_CLASS}`;
  if (state === 'not') return `${PILL_CHIP_CLASS} ${PILL_CHIP_NOT_CLASS}`;
  return PILL_CHIP_CLASS;
}

/**
 * The field button's label for one state: the bare field name while nothing
 * filters on this value yet (there is no operator to show), else the name
 * with the operator the CURRENT state reads as — clicking it is what moves
 * to the next one.
 */
export function pillFieldLabel(field: string, state: PillValueState): string {
  if (state === 'not') return `${field} ${PILL_OP_NOT_EQ}`;
  if (state === 'on') return `${field} ${PILL_OP_EQ}`;
  return field;
}

/**
 * The chip's CSS, shared by the header's shadow root (`view-window.ts`) and a
 * body pill's (same shadow root, since the template HTML is injected into
 * it via `unsafeHTML` — but kept here rather than assumed, because
 * `viz-custom-html.ts` is a SEPARATE component with its own shadow root and
 * needs the same rules to draw its own, simpler pill — see `viz-tokens.ts`).
 *
 * `vertical-align: baseline` matters only for a body pill: a header chip
 * always sits in the `.vw-sortbar` FLEX row, where vertical-align has no
 * effect, but a body pill sits inline in a sentence of card text, where it
 * does — without it the chip rode high against the surrounding baseline.
 *
 * **No `font-size` here, deliberately.** A chip takes the size of whatever it
 * sits in: the toolbar sets its own (`.vw-sortbar`, 0.82rem), and a body pill
 * matches the card text around it, which is what its own `font: inherit`
 * always did before the two shared a definition. Naming a size here shrank
 * every pill in a card to toolbar size, which reads as a rendering fault
 * rather than as a style.
 */
export const pillChipStyles = css`
  .eda-pill-chip {
    display: inline-flex;
    align-items: center;
    vertical-align: baseline;
    gap: 0.3rem;
    padding: 0.1rem 0.3rem 0.1rem 0.55rem;
    border-radius: 1rem;
    background: #e0f2fe;
    color: #0369a1;
  }
  /* A chip is one or two buttons, because it does one or two things: the
     FIELD (when present) cycles = / ≠ / off, and the VALUE opens the field's
     other values as a checklist. A viz-custom pill has no field button —
     see viz-tokens.ts — so this rule has to hold for either shape. */
  .eda-pill-chip-field,
  .eda-pill-chip-value {
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .eda-pill-chip-field {
    font-weight: 600;
  }
  .eda-pill-chip-field:hover,
  .eda-pill-chip-value:hover {
    text-decoration: underline;
  }
  /* Idle: nothing is filtering on this value yet. Quiet and dashed so it
     reads as an offer, not as an active filter. */
  .eda-pill-chip.off {
    background: transparent;
    border: 1px dashed #7dd3fc;
    color: #0369a1;
    opacity: 0.75;
    padding: 0 0.3rem;
  }
  .eda-pill-chip.off:hover {
    opacity: 1;
    border-style: solid;
  }
  /* An excluded value reads as excluded at a glance, not only by its ≠. */
  .eda-pill-chip.not {
    background: #fee2e2;
    color: #b91c1c;
  }
  .eda-pill-chip.not .eda-pill-chip-remove:hover {
    background: rgba(185, 28, 28, 0.15);
  }
  .eda-pill-chip-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.1rem;
    height: 1.1rem;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: inherit;
    cursor: pointer;
    line-height: 1;
  }
  .eda-pill-chip-remove:hover {
    background: rgba(3, 105, 161, 0.15);
  }
`;
