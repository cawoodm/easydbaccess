// packages/renderer/src/dialogs/script-samples.ts
//
// The ready-made scripts the script editor offers from its "Start from a
// sample" dropdown — one list per kind of thing it edits:
//   - RENDER_SAMPLES     → `function render(row)`, what a column DISPLAYS
//   - VALIDATE_SAMPLES   → `function validate(value, row)`, what it ACCEPTS
//   - VIZ_HTML_SAMPLES   → the markup of a custom visualization
//   - VIZ_SCRIPT_SAMPLES → `function render(rows, api)`, its optional code half
//
// Each one is complete and runnable: picking it and hitting Save gives a
// working script, and the common case is then editing a field name or a number
// inside it rather than writing from scratch.
//
// Kept as a pure data module (no Lit, no DOM) so the samples can be compiled
// and exercised in unit tests: a sample that no longer parses, or that rejects
// the value it is supposed to accept, is a bug the suite should catch rather
// than something the user discovers in the dialog.
//
// House style for every sample:
//   - it survives a half-filled row. A render sample returns '' rather than
//     "undefined undefined"; a validate sample lets a blank value through
//     (use "Required" to forbid it, and compose the two by keeping the early
//     return) — otherwise every optional column would start rejecting the
//     empty state it ships in;
//   - a validate sample's thrown message names what was wrong in the user's
//     terms, since it is shown verbatim in the "Cannot save" dialog;
//   - the tunable part (a field name, a rate, a pattern, a list) sits on its
//     own line near the top, so editing the sample means editing one obvious
//     thing;
//   - when the sample only makes sense with a particular renderer, its first
//     comment line says which. The dropdown can't set the renderer — that is
//     the column's own dropdown, two controls away — so it has to say so.

export interface ScriptSample {
  /** Shown in the dropdown. */
  label: string;
  /** Full script body — defines the function its kind expects. */
  source: string;
}

/** @deprecated Use {@link ScriptSample}; kept so older imports still resolve. */
export type ValidateSample = ScriptSample;

/**
 * Which shape a sample has — the four lists below, and the four lists a user's
 * own samples fall into.
 *
 * A VIEW TOKEN's script is `render(row)` like a column's, so it shares the
 * `render` list: a sample saved from a column shows up in a view's token editor
 * and the other way round.
 *
 * A custom visualization's two blocks do NOT share a list with each other, even
 * though one dialog edits both. A sample is pasted whole, and an HTML body
 * pasted into the script box is not something the user can edit their way out
 * of — so the markup and the code are kept apart.
 */
export type SampleKind = 'render' | 'validate' | 'viz-html' | 'viz-script';

const SAMPLE_KINDS: ReadonlyArray<SampleKind> = ['render', 'validate', 'viz-html', 'viz-script'];

/** A sample the USER saved, kept in the workspace settings under {@link USER_SAMPLES_SETTING}. */
export interface UserScriptSample extends ScriptSample {
  /** Stable identity for delete — labels are free text and may repeat. */
  id: string;
  kind: SampleKind;
}

/**
 * The settings key holding the user's own samples, as one JSON array.
 *
 * A workspace setting rather than a device-local one: a sample is content, like
 * a view template, so it should travel with the workspace through a gist push or
 * a dump — not stay behind on the machine it was written on.
 */
export const USER_SAMPLES_SETTING = 'scripts:samples';

/** The built-in samples for one kind. */
export function builtinSamples(kind: SampleKind): ReadonlyArray<ScriptSample> {
  if (kind === 'validate') return VALIDATE_SAMPLES;
  if (kind === 'viz-html') return VIZ_HTML_SAMPLES;
  if (kind === 'viz-script') return VIZ_SCRIPT_SAMPLES;
  return RENDER_SAMPLES;
}

/**
 * Read the stored list, tolerating anything. The value comes back from a store
 * that may have been synced from another device or hand-edited in a dump, so a
 * malformed entry is dropped rather than allowed to break the dialog — a broken
 * sample list must not cost the user their script editor.
 */
export function parseUserSamples(value: unknown): UserScriptSample[] {
  const raw = typeof value === 'string' ? tryParseJson(value) : value;
  if (!Array.isArray(raw)) return [];
  const out: UserScriptSample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, kind, label, source } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    if (typeof label !== 'string' || !label.trim()) continue;
    if (typeof source !== 'string' || !source.trim()) continue;
    // An unknown kind falls back to `render`, which is where every sample lived
    // before the list split — a workspace written by an older build has no
    // `kind` worth trusting and its samples are all column scripts.
    const k = SAMPLE_KINDS.includes(kind as SampleKind) ? (kind as SampleKind) : 'render';
    out.push({ id, kind: k, label: label.trim(), source });
  }
  return out;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** The user's samples of one kind, in the order they were saved. */
export function userSamplesFor(all: ReadonlyArray<UserScriptSample>, kind: SampleKind): UserScriptSample[] {
  return all.filter((s) => s.kind === kind);
}

/** `all` with one more sample appended. Pure — the caller persists the result. */
export function addUserSample(all: ReadonlyArray<UserScriptSample>, sample: UserScriptSample): UserScriptSample[] {
  return [...all, sample];
}

/** `all` without the sample carrying `id`. */
export function removeUserSample(all: ReadonlyArray<UserScriptSample>, id: string): UserScriptSample[] {
  return all.filter((s) => s.id !== id);
}

/**
 * `render(row)` samples. Between them they cover the three things people
 * actually ask a column script for: text assembled from other fields, a URL
 * built out of a value, and arithmetic over the row.
 */
export const RENDER_SAMPLES: ReadonlyArray<ScriptSample> = [
  {
    label: 'Join two fields into one',
    source: `function render(row) {
  // The simplest useful script: read any field by name off \`row\`.
  return [row.first, row.last].filter(Boolean).join(' ');
}
`,
  },
  {
    label: 'Markdown → formatted text (markdownToHtml)',
    source: `function render(row) {
  // Set this column's renderer to \`html\`, or the cell shows the HTML source.
  // markdownToHtml SANITISES: formatting in the data survives, a <script>
  // or an onerror= arriving from a CSV does not.
  return markdownToHtml(row.notes ?? '');
}
`,
  },
  {
    label: 'Markdown summary — first line, bolded label',
    source: `function render(row) {
  // Renderer: \`html\`. Builds the Markdown first, then converts it — easier to
  // read than assembling tags by hand, and the sanitising comes for free.
  if (!row.title && !row.notes) return ''; // nothing to summarise yet
  const first = String(row.notes ?? '').split('\\n')[0] ?? '';
  return markdownToHtml(\`**\${row.title ?? 'Untitled'}** — \${first}\`);
}
`,
  },
  {
    label: 'Build a URL from a field',
    source: `function render(row) {
  // Renderer: \`link\`, which turns the returned URL into a clickable anchor.
  const BASE = 'https://github.com/';
  if (!row.repo) return '';
  return BASE + encodeURIComponent(String(row.repo));
}
`,
  },
  {
    label: 'Build a URL with query parameters',
    source: `function render(row) {
  // Renderer: \`link\`. \`URL\` + \`searchParams\` encodes the values for you, so
  // spaces and & in the data can't break the link.
  if (!row.city) return '';
  const url = new URL('https://www.openstreetmap.org/search');
  url.searchParams.set('query', \`\${row.street ?? ''} \${row.city}\`.trim());
  return url.toString();
}
`,
  },
  {
    label: 'Mailto link with a prefilled subject',
    source: `function render(row) {
  // Renderer: \`link\`.
  if (!row.email) return '';
  const subject = encodeURIComponent(\`Re: \${row.title ?? 'your enquiry'}\`);
  return \`mailto:\${row.email}?subject=\${subject}\`;
}
`,
  },
  {
    label: 'Maths — line total (quantity × price)',
    source: `function render(row) {
  // Blank, not "0.00", until both parts are there — a column of zeroes down a
  // half-filled table looks like data.
  const qty = Number(row.qty);
  const price = Number(row.price);
  if (row.qty == null || row.qty === '' || !Number.isFinite(qty)) return '';
  if (row.price == null || row.price === '' || !Number.isFinite(price)) return '';
  return (qty * price).toFixed(2);
}
`,
  },
  {
    label: 'Maths — amount as money (Intl.NumberFormat)',
    source: `function render(row) {
  const CURRENCY = 'CHF';
  const LOCALE = 'de-CH';
  const n = Number(row.amount);
  if (!Number.isFinite(n)) return '';
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY }).format(n);
}
`,
  },
  {
    label: 'Maths — percentage of a total',
    source: `function render(row) {
  const part = Number(row.done ?? 0);
  const whole = Number(row.total ?? 0);
  if (!whole) return ''; // no divide-by-zero, and no "NaN%" in the grid
  return Math.round((part / whole) * 100) + '%';
}
`,
  },
  {
    label: 'Days between a date and today',
    source: `function render(row) {
  const FIELD = 'due';
  if (!row[FIELD]) return '';
  const then = new Date(String(row[FIELD]));
  if (Number.isNaN(then.getTime())) return '';
  // Whole days, not elapsed hours: a date-only value must read the same at
  // 09:00 and at 23:00, or "today" turns into "1 days ago" over lunch.
  const day = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000;
  const days = day(then) - day(new Date());
  if (days === 0) return 'today';
  return days > 0 ? \`in \${days} days\` : \`\${-days} days ago\`;
}
`,
  },
];

/** `validate(value, row)` samples — see the header note on the house style. */
export const VALIDATE_SAMPLES: ReadonlyArray<ScriptSample> = [
  {
    label: 'Required — reject an empty cell',
    source: `function validate(value, row) {
  if (value === null || value === undefined || String(value).trim() === '') {
    throw new Error('This field is required.');
  }
}
`,
  },
  {
    label: 'Email address',
    source: `function validate(value, row) {
  if (value == null || value === '') return; // blank is allowed
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]{2,}$/.test(String(value))) {
    throw new Error(\`"\${value}" is not a valid email address.\`);
  }
}
`,
  },
  {
    label: 'Web address (http / https)',
    source: `function validate(value, row) {
  if (value == null || value === '') return;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(\`"\${value}" is not a valid URL.\`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http:// and https:// addresses are allowed.');
  }
}
`,
  },
  {
    label: 'Whole number in a range',
    source: `function validate(value, row) {
  const MIN = 1;
  const MAX = 100;
  if (value == null || value === '') return;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(\`"\${value}" is not a whole number.\`);
  if (n < MIN || n > MAX) throw new Error(\`Must be between \${MIN} and \${MAX} (got \${n}).\`);
}
`,
  },
  {
    label: 'Positive number',
    source: `function validate(value, row) {
  if (value == null || value === '') return;
  const n = Number(value);
  if (Number.isNaN(n)) throw new Error(\`"\${value}" is not a number.\`);
  if (n <= 0) throw new Error('Must be greater than zero.');
}
`,
  },
  {
    label: 'Text length between two limits',
    source: `function validate(value, row) {
  const MIN = 3;
  const MAX = 40;
  if (value == null || value === '') return;
  const len = String(value).trim().length;
  if (len < MIN) throw new Error(\`Too short — at least \${MIN} characters (got \${len}).\`);
  if (len > MAX) throw new Error(\`Too long — at most \${MAX} characters (got \${len}).\`);
}
`,
  },
  {
    label: 'One of a fixed list of values',
    source: `function validate(value, row) {
  const ALLOWED = ['draft', 'review', 'published'];
  if (value == null || value === '') return;
  if (!ALLOWED.includes(String(value))) {
    throw new Error(\`"\${value}" is not allowed. Pick one of: \${ALLOWED.join(', ')}.\`);
  }
}
`,
  },
  {
    label: 'Matches a pattern (regular expression)',
    source: `function validate(value, row) {
  const PATTERN = /^[A-Z]{2}-\\d{4}$/; // e.g. AB-1234
  if (value == null || value === '') return;
  if (!PATTERN.test(String(value))) {
    throw new Error(\`"\${value}" doesn't match the required format (e.g. AB-1234).\`);
  }
}
`,
  },
  {
    label: 'A real date, not in the future',
    source: `function validate(value, row) {
  if (value == null || value === '') return;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) throw new Error(\`"\${value}" is not a date.\`);
  // Compare whole days, so "today" is never rejected by a few hours.
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (d > today) throw new Error('The date cannot be in the future.');
}
`,
  },
  {
    label: 'Depends on another column (end after start)',
    source: `function validate(value, row) {
  // \`row\` is the whole row, so a rule can compare fields. Rename 'start' to
  // whichever column this one has to come after.
  const OTHER = 'start';
  if (value == null || value === '') return;
  const other = row?.[OTHER];
  if (other == null || other === '') return; // nothing to compare against yet
  if (new Date(String(value)) < new Date(String(other))) {
    throw new Error(\`Must not be earlier than \${OTHER} (\${other}).\`);
  }
}
`,
  },
];

/**
 * `viz-html` samples — the markup half of a custom visualization.
 *
 * These are the feature's documentation, not a nicety. A blank textarea headed
 * "HTML" teaches nobody what a custom visualization can be, and the dropdown is
 * how the shape is discovered — so every one of them draws something the first
 * time it is picked, and the field names inside it are the only thing that
 * normally needs editing.
 *
 * The tokens describe the WHOLE set the pane was given, not one row (see
 * `viz/viz-tokens.ts`): `$COUNT` is how many rows are on screen, `$SUM.amount`
 * their total, `$filter.country` a clickable pill per distinct value.
 *
 * Several of them carry a `#goto?…` COMMANDLET link. A commandlet with no table
 * name acts on the table the click came from (`plugins/commandlet-run.ts`), so a
 * sample can filter, sort or search without naming a table — which is what makes
 * one block of markup work on every table it is dropped onto. Written with
 * `&amp;` rather than a bare `&`, because these land in the document as HTML.
 */
export const VIZ_HTML_SAMPLES: ReadonlyArray<ScriptSample> = [
  {
    label: 'KPI tile — one big number',
    source: `<!-- The whole vocabulary in one line: $COUNT is how many rows the grid
     is showing right now, so this tile follows every filter you type. -->
<div style="text-align:center;padding:1rem 0">
  <div style="font-size:2.6rem;font-weight:700;line-height:1">$COUNT</div>
  <div style="opacity:.7;text-transform:uppercase;letter-spacing:.06em;font-size:.7rem">Rows</div>
</div>
`,
  },
  {
    label: 'KPI strip — three tiles in a row',
    source: `<!-- Needs a numeric column. Rename \`amount\` to yours. -->
<div style="display:flex;gap:.5rem;text-align:center">
  <div style="flex:1;padding:.6rem;border-radius:.5rem;background:rgba(127,127,127,.1)">
    <div style="font-size:1.6rem;font-weight:700">$COUNT</div>
    <div style="opacity:.7;font-size:.7rem">ROWS</div>
  </div>
  <div style="flex:1;padding:.6rem;border-radius:.5rem;background:rgba(127,127,127,.1)">
    <div style="font-size:1.6rem;font-weight:700">$SUM.amount</div>
    <div style="opacity:.7;font-size:.7rem">TOTAL</div>
  </div>
  <div style="flex:1;padding:.6rem;border-radius:.5rem;background:rgba(127,127,127,.1)">
    <div style="font-size:1.6rem;font-weight:700">$AVG.amount</div>
    <div style="opacity:.7;font-size:.7rem">AVERAGE</div>
  </div>
</div>
`,
  },
  {
    label: 'Filter pills — a header that narrows the grid',
    source: `<!-- Needs a column with a few repeated values. Rename \`country\` to yours.
     One pill per distinct value; clicking one narrows the grid this pane is
     docked to. The Clear link is a commandlet — see the Toolbar sample. -->
<div style="display:flex;flex-wrap:wrap;align-items:center;gap:.15rem">
  <span style="opacity:.7;margin-right:.35rem">Country:</span>
  $filter.country
  <a href="#goto?@clear" style="margin-left:.4rem;opacity:.7">clear</a>
</div>
`,
  },
  {
    label: 'Toolbar — commandlet links that filter, sort and search',
    source: `<!-- A #link starting with \`goto\` and NO table name acts on the table this
     pane is in, so the same block works wherever you drop it. Rename
     \`country\` and \`amount\` to your columns. -->
<div style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center">
  <a href="#goto?country==CH">Only CH</a>
  <a href="#goto?country=^C">Starts with C</a>
  <a href="#goto?amount=!NULL">Has an amount</a>
  <a href="#goto?@sort=-amount">Biggest first</a>
  <a href="#goto?@sort=country,-amount">By country, then size</a>
  <a href="#goto?@search=berlin">Search “berlin”</a>
  <a href="#goto?@clear&amp;@search=">Reset</a>
</div>
`,
  },
  {
    label: 'Summary line — a sentence with the numbers in it',
    source: `<!-- The smallest useful template. Rename \`amount\` and \`country\`. -->
<p style="margin:0">
  Showing <strong>$COUNT</strong> rows across <strong>$DISTINCT.country</strong>
  countries, totalling <strong>$SUM.amount</strong>
  (from $MIN.amount to $MAX.amount).
</p>
`,
  },
  {
    label: 'Table of counts — when a chart is more than you want',
    source: `<!-- Needs two columns: one to name the thing, one to measure it.
     Rename \`country\` and \`amount\`. -->
<table style="width:100%;border-collapse:collapse">
  <tbody>
    <tr><td style="padding:.2rem 0">Rows</td><td style="text-align:right;font-weight:600">$COUNT</td></tr>
    <tr><td style="padding:.2rem 0"><a href="#goto?@sort=country">Countries</a></td><td style="text-align:right;font-weight:600">$DISTINCT.country</td></tr>
    <tr><td style="padding:.2rem 0"><a href="#goto?@sort=-amount">Total</a></td><td style="text-align:right;font-weight:600">$SUM.amount</td></tr>
    <tr><td style="padding:.2rem 0">Average</td><td style="text-align:right;font-weight:600">$AVG.amount</td></tr>
  </tbody>
</table>
`,
  },
];

/**
 * `viz-script` samples — the optional code half.
 *
 * Two of them, and deliberately two: the contract has exactly two halves, so one
 * sample returns a string and the other writes into `api.el`, and between them
 * every part of the `api` is used once.
 */
export const VIZ_SCRIPT_SAMPLES: ReadonlyArray<ScriptSample> = [
  {
    label: 'Return a string — a grouped count table',
    source: `function render(rows, api) {
  // Rename \`country\` to the column you want to group by. Returning a string
  // replaces the container's markup, so the HTML box can be left empty.
  const FIELD = 'country';
  const counts = new Map();
  for (const row of rows) {
    const key = String(row.data[FIELD] ?? '(blank)');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length === 0) return '<p style="opacity:.7">Nothing to count.</p>';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return \`<table style="width:100%;border-collapse:collapse">\` +
    top.map(([k, n]) =>
      \`<tr><td style="padding:.15rem 0">\${esc(k)}</td>\` +
      \`<td style="text-align:right;font-weight:600">\${n}</td></tr>\`).join('') +
    \`</table>\`;
}
`,
  },
  {
    label: 'Write into api.el — clickable buttons that filter the grid',
    source: `function render(rows, api) {
  // The other half of the contract: build real elements instead of a string,
  // so each one can carry its own click handler. api.filter() asks the grid
  // this pane is docked to to narrow — the same thing a $filter. pill does.
  const FIELD = 'country';
  const values = [...new Set(rows.map((r) => r.data[FIELD]).filter((v) => v != null && v !== ''))].sort();
  api.el.replaceChildren();
  if (values.length === 0) {
    api.el.textContent = 'No values in ' + FIELD + '.';
    return;
  }
  for (const v of values.slice(0, 20)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = String(v);
    b.style.cssText = 'margin:.1rem;padding:.1rem .5rem;border:none;border-radius:1rem;background:#e0f2fe;color:#0369a1;cursor:pointer';
    b.addEventListener('click', () => api.filter(FIELD, String(v)));
    api.el.append(b);
  }
}
`,
  },
];
