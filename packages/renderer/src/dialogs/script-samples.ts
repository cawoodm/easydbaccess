// packages/renderer/src/dialogs/script-samples.ts
//
// The ready-made scripts the script editor offers from its "Start from a
// sample" dropdown — one list per kind of column script:
//   - RENDER_SAMPLES   → `function render(row)`, what the column DISPLAYS
//   - VALIDATE_SAMPLES → `function validate(value, row)`, what it ACCEPTS
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
