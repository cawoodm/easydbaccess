// packages/renderer/src/views/record-html.ts
//
// The two pure pieces a record pane needs: how its tokens resolve, and what it
// draws when nobody has written any HTML.
//
// **Tokens ARE field names here.** A view template's `$TOKEN` is a mapping key —
// `ViewInstance.mapping` says which column it reads, which is what lets one
// global template serve several tables. A record layout is written against ONE
// table and names its columns directly: `$title`, `$input.body`, `$raw.created`.
//
// That is not a second token language. `substituteRow` already takes the mapping
// as an argument, so handing it an IDENTITY mapping makes the token the field and
// changes nothing in `view-render.ts` — every prefix, every renderer slot and
// every `$input` control behaves exactly as it does in a view.
//
// Pure and DOM-free, so both halves are unit-tested in plain Node.

import type { ColumnSpec, ViewInstance, ViewTemplate } from '@easydb/shared';

/**
 * `{ field: field }` for every column — what makes a token its own field name.
 *
 * Built from the column specs rather than from the row's own keys, so a token
 * naming a column that exists but is empty on this row still resolves (and
 * renders as nothing), while a token naming no column at all renders as nothing
 * too. Reading `row.data`'s keys instead would make a template's behaviour
 * depend on which record you happened to be looking at.
 */
export function identityMapping(columns: readonly ColumnSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of columns) out[c.field] = c.field;
  return out;
}

/** Columns a generated card shows, in order. Hidden ones are left out. */
export function cardColumns(columns: readonly ColumnSpec[], visible?: readonly string[] | undefined): ColumnSpec[] {
  if (!visible || visible.length === 0) return [...columns];
  const wanted = new Set(visible);
  return columns.filter((c) => wanted.has(c.field));
}

/**
 * The card drawn when the layout is empty: every visible column as a label and a
 * value, each value through its own cell renderer.
 *
 * **This is the feature for most people**, and it is why the pane does not start
 * as an empty textarea. A record view that must be written before it shows
 * anything is one nobody switches on; a card that is already right, with "edit
 * this layout" as the escape hatch, is one people keep.
 *
 * It is generated as TOKEN HTML rather than drawn directly, so it goes through
 * exactly the same `substituteRow` pass a hand-written layout does — one code
 * path, and the generated markup is therefore also a valid starting point to
 * hand the user when they press Edit (see {@link startingHtml}).
 *
 * `$` is deliberately not escaped in the label: a column called `Cost $` would
 * otherwise produce a token. Labels go in as text, values as tokens, and the two
 * are built separately for that reason.
 */
export function generatedCardHtml(columns: readonly ColumnSpec[], opts: { editable?: boolean } = {}): string {
  const prefix = opts.editable === true ? 'input.' : '';
  const rows = columns.map(
    (c) => `  <div class="eda-rec-row">\n` + `    <div class="eda-rec-label">${escapeText(c.label || c.field)}</div>\n` + `    <div class="eda-rec-value">$${prefix}${c.field}</div>\n` + `  </div>`,
  );
  return `<div class="eda-rec-card">\n${rows.join('\n')}\n</div>`;
}

/**
 * What the Edit box is filled with when the layout is still empty.
 *
 * The generated card's own markup, so the user's first edit is a CHANGE to
 * something that already works rather than a blank page — and the EDITABLE
 * markup, because that is what an empty layout draws. A starting point that
 * differs from what was on screen a moment ago is a puzzle, not a head start.
 */
export function startingHtml(columns: readonly ColumnSpec[]): string {
  return generatedCardHtml(columns, { editable: true });
}

/**
 * The record layout this table uses, or `''` when it has none.
 *
 * "The table's layout" is a `ViewInstance` of it whose template is a `record`
 * visualization — an instance is what binds a workspace-wide template to one
 * table, so a record template nobody has bound here is not this table's layout.
 * Its dock does not matter: a layout written for a pane is the same layout, and
 * the record WINDOW opens exactly when no pane is docked.
 *
 * Sorted by id so two instances give a stable answer rather than one that
 * depends on the order the store happened to return.
 *
 * Pure, and takes plain arrays, so the rule is unit-testable without a store.
 */
export function recordLayoutFor(instances: readonly ViewInstance[], templates: readonly ViewTemplate[], tableId: string): string {
  const byId = new Map(templates.map((t) => [t.id, t]));
  const mine = instances.filter((i) => i.tableId === tableId).sort((a, b) => a.id.localeCompare(b.id));
  for (const inst of mine) {
    const t = byId.get(inst.templateId);
    if (t?.kind !== 'viz' || t.viz?.kind !== 'record') continue;
    const html = t.viz.options?.['html'];
    if (typeof html === 'string' && !isEmptyLayout(html)) return html;
  }
  return '';
}

/**
 * Is this layout empty?
 *
 * Whitespace-only counts as empty: a textarea the user opened, looked at and
 * closed must not turn the generated card off.
 */
export function isEmptyLayout(html: string | undefined): boolean {
  return (html ?? '').trim() === '';
}

/** Text going into the generated markup, not into an attribute. */
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
