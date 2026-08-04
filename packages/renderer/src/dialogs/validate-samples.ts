// packages/renderer/src/dialogs/validate-samples.ts
//
// The ready-made validators the script editor offers from its "Start from a
// sample" dropdown. Each one is a complete, runnable `validate(value, row)` —
// picking one and hitting Save gives a working rule, and the common case is
// then editing a number or a list inside it rather than writing from scratch.
//
// Kept as a pure data module (no Lit, no DOM) so the samples can be compiled
// and exercised in unit tests: a sample that no longer parses, or that rejects
// the value it is supposed to accept, is a bug the suite should catch rather
// than something the user discovers in the dialog.
//
// House style for every sample:
//   - a blank value passes (use "Required" to forbid it, and compose the two
//     by keeping the early return) — otherwise every optional column would
//     start rejecting the empty state it ships in;
//   - the thrown message names what was wrong in the user's terms, since it is
//     shown verbatim in the "Cannot save" dialog;
//   - the tunable part (a pattern, a range, a list) sits on its own line near
//     the top, so editing the sample means editing one obvious thing.

export interface ValidateSample {
  /** Shown in the dropdown. */
  label: string;
  /** Full script body — defines `function validate(value, row)`. */
  source: string;
}

export const VALIDATE_SAMPLES: ReadonlyArray<ValidateSample> = [
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
