// packages/renderer/src/plugins/tag-suggest.ts
//
// What to offer while someone types into an `array` cell, and what taking it
// does to the text. Pure, so the fiddly part — where one tag ends — is pinned by
// unit tests rather than by clicking.
//
// A tags cell is edited as its RAW text (`cell-tags.ts` explains why), and that
// text may be a comma list (`red, green`) or a JSON array (`["red","green"]`).
// So a suggestion cannot look at the whole field the way a native `<datalist>`
// does: in `red, gr` the word being typed is `gr`, and matching the whole value
// against the column's vocabulary would offer nothing at all. The term is
// therefore whatever sits between the last separator and the caret — which is
// also what makes the list work when the caret is put back into the middle of a
// list already typed.

/** Most suggestions shown at once. A cell editor is one line in a grid row. */
export const SUGGEST_MAX = 8;

/**
 * Where the caret is, or what is selected.
 *
 * A range, not an index, because the editor opens with its whole value SELECTED
 * (so typing replaces it). With only an index to go on, `selectionStart` there is
 * 0 and a suggestion would be spliced in FRONT of the text it was meant to
 * replace — `blue` picked over a selected `green` gave `bluegreen`.
 */
export interface Caret {
  from: number;
  to: number;
}

/** The caret of a live input, as a range. */
export function caretOf(input: { value: string; selectionStart: number | null; selectionEnd: number | null }): Caret {
  const a = input.selectionStart ?? input.value.length;
  const b = input.selectionEnd ?? a;
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/** Where one tag starts and ends around the caret, and how it was quoted. */
export interface TagTerm {
  /** Index the term starts at — after any separator, quote and space. */
  start: number;
  /** Index the term ends at. */
  end: number;
  /** The word being typed, without its quotes. */
  term: string;
  /** `"`, `'` or empty — so an insert into a JSON array stays valid JSON. */
  quote: string;
}

/** Separators between members, in both spellings. */
const SEPARATORS = new Set([',', '[', '\n']);

/** Step over a leading space and an opening quote; report the quote found. */
function openQuote(text: string, start: number, end: number): { start: number; quote: string } {
  let i = start;
  while (i < end && text[i] === ' ') i++;
  const ch = text[i] ?? '';
  if (i < end && (ch === '"' || ch === "'")) return { start: i + 1, quote: ch };
  return { start: i, quote: '' };
}

export function termAt(text: string, caret: Caret): TagTerm {
  const from = Math.max(0, Math.min(caret.from, text.length));
  const to = Math.max(from, Math.min(caret.to, text.length));

  // A selection IS the term: it is what typing would replace, so it is what a
  // suggestion replaces too.
  if (to > from) {
    const open = openQuote(text, from, to);
    let term = text.slice(open.start, to);
    if (open.quote && term.endsWith(open.quote)) term = term.slice(0, -1);
    return { start: open.start, end: to, term, quote: open.quote };
  }

  let start = 0;
  for (let i = from - 1; i >= 0; i--) {
    if (SEPARATORS.has(text[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  const open = openQuote(text, start, from);
  let term = text.slice(open.start, from);
  // A closing quote can only be here if the caret sits right after it.
  if (open.quote && term.endsWith(open.quote)) term = term.slice(0, -1);
  return { start: open.start, end: from, term, quote: open.quote };
}

/** Every member the text names OUTSIDE the term, lower-cased. */
function alreadyChosen(text: string, t: TagTerm): Set<string> {
  const out = new Set<string>();
  for (const part of `${text.slice(0, t.start)} ${text.slice(t.end)}`.split(/[,[\]\n ]/)) {
    const member = part.trim().replace(/^["']|["']$/g, '');
    if (member) out.add(member.toLowerCase());
  }
  return out;
}

/**
 * The column's values worth offering for what is being typed.
 *
 * Three rules, each earning its place:
 *
 *  - **Values already in this cell are left out.** A tag list is a set; offering
 *    a tag the cell already carries can only produce a duplicate. "Already" means
 *    in the TEXT, not in the stored cell — the text is what will be saved.
 *  - **An empty term offers everything** (up to the cap). Clicking into an empty
 *    cell and seeing the vocabulary is most of the point — otherwise the feature
 *    only helps someone who already knows what they are looking for.
 *  - **Starts-with beats contains.** `gre` should put `green` above `evergreen`;
 *    within each group the incoming order (sorted, from `facetValues`) is kept.
 */
export function suggestTags(all: readonly string[], text: string, caret: Caret, opts?: { max?: number }): string[] {
  const t = termAt(text, caret);
  const chosen = alreadyChosen(text, t);
  const needle = t.term.trim().toLowerCase();
  const starts: string[] = [];
  const holds: string[] = [];
  for (const value of all) {
    const low = value.toLowerCase();
    if (chosen.has(low)) continue;
    if (needle === '' || low.startsWith(needle)) starts.push(value);
    else if (low.includes(needle)) holds.push(value);
  }
  return [...starts, ...holds].slice(0, opts?.max ?? SUGGEST_MAX);
}

/** The text and caret after a suggestion is taken. */
export interface TagApplied {
  text: string;
  caret: number;
}

/**
 * Replace the term at the caret with `pick`.
 *
 * A pick at the very end of the text gets `, ` after it, so the next tag can be
 * typed without reaching for the comma — a trailing separator is harmless,
 * `arrayMembers` drops empty members. Anywhere else nothing is added: the
 * separator being typed between is already there.
 */
export function applyTag(text: string, caret: Caret, pick: string): TagApplied {
  const t = termAt(text, caret);
  const tail = text.slice(t.end);
  const insert = t.quote ? `${pick}${t.quote}` : pick;
  const trailing = tail.trim() === '' && !t.quote ? ', ' : '';
  const head = text.slice(0, t.start) + insert + trailing;
  // Past a closing quote the caret would otherwise land inside the string.
  const skip = t.quote && tail.startsWith(t.quote) ? 1 : 0;
  return { text: head + tail.slice(skip), caret: head.length };
}

/**
 * Add `pick` to the end of the list, in the spelling the text already uses.
 *
 * A different act from {@link applyTag}, and the distinction is the whole reason
 * both exist. Completing replaces the word being typed; ADDING leaves every word
 * alone. The list shown the moment the editor opens is an add — the editor opens
 * with its value selected, so completing there would replace the entire cell with
 * one tag, which is how picking a second tag lost the first.
 */
export function appendTag(text: string, pick: string): TagApplied {
  const t = text.trimEnd();
  if (t === '') return { text: `${pick}, `, caret: pick.length + 2 };
  // A JSON array closes with `]`, so the new member goes INSIDE it, quoted.
  if (t.endsWith(']')) {
    const inner = t.slice(0, -1).trimEnd();
    const sep = inner.endsWith('[') || inner.endsWith(',') ? '' : ', ';
    const next = `${inner}${sep}"${pick}"]`;
    return { text: next, caret: next.length - 1 };
  }
  const sep = t.endsWith(',') ? ' ' : ', ';
  const next = `${t}${sep}${pick}, `;
  return { text: next, caret: next.length };
}
