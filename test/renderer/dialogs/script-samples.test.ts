// Every sample the script editor offers is real code the user can save
// unchanged, so the suite treats them as code: each one must compile, must
// produce what it advertises, and — for a validator — must reject the value it
// exists to catch. A typo in a sample is otherwise only found by the person who
// picked it and got a "compile error" instead of a working script.

import { describe, expect, it } from 'vitest';
import { RENDER_SAMPLES, VALIDATE_SAMPLES } from '../../../packages/renderer/src/dialogs/script-samples.js';
import { runColumnScript, runValidateScript } from '../../../packages/renderer/src/util/column-script.js';

/** Run a validate sample by label — fails loudly if the label ever drifts. */
function run(label: string, value: unknown, row: Record<string, unknown> = {}) {
  const sample = VALIDATE_SAMPLES.find((s) => s.label === label);
  if (!sample) throw new Error(`no sample labelled "${label}"`);
  return runValidateScript(sample.source, value, row);
}

/** Run a render sample by label, returning its computed value. */
function render(label: string, row: Record<string, unknown>): unknown {
  const sample = RENDER_SAMPLES.find((s) => s.label === label);
  if (!sample) throw new Error(`no sample labelled "${label}"`);
  const out = runColumnScript(sample.source, row);
  if (!out.ok) throw new Error(`${label}: ${out.label} — ${out.message}`);
  return out.value;
}

const REQUIRED = 'Required — reject an empty cell';

describe('VALIDATE_SAMPLES', () => {
  it('offers exactly ten samples, each with a distinct label', () => {
    expect(VALIDATE_SAMPLES).toHaveLength(10);
    expect(new Set(VALIDATE_SAMPLES.map((s) => s.label)).size).toBe(10);
  });

  it('every sample compiles and defines validate(value, row)', () => {
    for (const s of VALIDATE_SAMPLES) {
      // A plausible value for each: what matters is that nothing throws a
      // SyntaxError or a ReferenceError, which surface as compile errors.
      const out = runValidateScript(s.source, '', {});
      if (!out.ok) expect(out.message, s.label).not.toMatch(/compile error/);
    }
  });

  it('leaves a blank cell alone — except the Required rule, which is the point of it', () => {
    for (const s of VALIDATE_SAMPLES) {
      const out = runValidateScript(s.source, '', {});
      expect(out.ok, s.label).toBe(s.label !== REQUIRED);
    }
  });
});

describe('each sample accepts and rejects what it says it does', () => {
  it('Required', () => {
    expect(run(REQUIRED, 'x').ok).toBe(true);
    expect(run(REQUIRED, '   ').ok).toBe(false);
    expect(run(REQUIRED, null).ok).toBe(false);
    expect(run(REQUIRED, undefined).ok).toBe(false);
  });

  it('Email address', () => {
    const L = 'Email address';
    expect(run(L, 'marc@monads.ch').ok).toBe(true);
    expect(run(L, 'marc@monads').ok).toBe(false);
    expect(run(L, 'not an email').ok).toBe(false);
    expect(run(L, 'a@b.c').ok).toBe(false); // single-letter TLD
  });

  it('Web address', () => {
    const L = 'Web address (http / https)';
    expect(run(L, 'https://monads.ch/x?y=1').ok).toBe(true);
    expect(run(L, 'http://localhost:5190').ok).toBe(true);
    expect(run(L, 'javascript:alert(1)').ok).toBe(false);
    expect(run(L, 'monads.ch').ok).toBe(false); // no scheme ⇒ not a URL
  });

  it('Whole number in a range', () => {
    const L = 'Whole number in a range';
    expect(run(L, 50).ok).toBe(true);
    expect(run(L, '1').ok).toBe(true); // the grid may hand over a string
    expect(run(L, 101).ok).toBe(false);
    expect(run(L, 0).ok).toBe(false);
    expect(run(L, 1.5).ok).toBe(false);
    expect(run(L, 'ten').ok).toBe(false);
  });

  it('Positive number', () => {
    const L = 'Positive number';
    expect(run(L, 0.01).ok).toBe(true);
    expect(run(L, 0).ok).toBe(false);
    expect(run(L, -3).ok).toBe(false);
    expect(run(L, 'abc').ok).toBe(false);
  });

  it('Text length between two limits', () => {
    const L = 'Text length between two limits';
    expect(run(L, 'abc').ok).toBe(true);
    expect(run(L, 'ab').ok).toBe(false);
    expect(run(L, 'x'.repeat(41)).ok).toBe(false);
    // Trimmed, so padding doesn't buy length.
    expect(run(L, '  a  ').ok).toBe(false);
  });

  it('One of a fixed list of values', () => {
    const L = 'One of a fixed list of values';
    expect(run(L, 'draft').ok).toBe(true);
    expect(run(L, 'Draft').ok).toBe(false); // case-sensitive by design
    expect(run(L, 'archived').ok).toBe(false);
  });

  it('Matches a pattern', () => {
    const L = 'Matches a pattern (regular expression)';
    expect(run(L, 'AB-1234').ok).toBe(true);
    expect(run(L, 'ab-1234').ok).toBe(false);
    expect(run(L, 'AB-123').ok).toBe(false);
  });

  it('A real date, not in the future', () => {
    const L = 'A real date, not in the future';
    expect(run(L, '2020-01-01').ok).toBe(true);
    expect(run(L, new Date().toISOString().slice(0, 10)).ok).toBe(true); // today
    expect(run(L, '2999-01-01').ok).toBe(false);
    expect(run(L, 'not a date').ok).toBe(false);
  });

  it('Depends on another column', () => {
    const L = 'Depends on another column (end after start)';
    expect(run(L, '2026-02-01', { start: '2026-01-01' }).ok).toBe(true);
    expect(run(L, '2026-01-01', { start: '2026-01-01' }).ok).toBe(true); // equal is fine
    expect(run(L, '2025-12-31', { start: '2026-01-01' }).ok).toBe(false);
    // Nothing to compare against yet — an unfinished row is not an error.
    expect(run(L, '2026-02-01', {}).ok).toBe(true);
  });
});

describe('the rejection message reaches the caller', () => {
  it('is the thrown message, verbatim — it is what the user is shown', () => {
    const out = run('One of a fixed list of values', 'archived');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toBe('"archived" is not allowed. Pick one of: draft, review, published.');
  });
});

describe('RENDER_SAMPLES', () => {
  it('offers exactly ten samples, each with a distinct label', () => {
    expect(RENDER_SAMPLES).toHaveLength(10);
    expect(new Set(RENDER_SAMPLES.map((s) => s.label)).size).toBe(10);
  });

  it('every sample compiles and defines render(row)', () => {
    for (const s of RENDER_SAMPLES) {
      const out = runColumnScript(s.source, {});
      expect(out.ok, `${s.label}: ${out.ok ? '' : `${out.label} — ${out.message}`}`).toBe(true);
    }
  });

  it('returns a blank string for an empty row rather than "undefined" or NaN', () => {
    // A script runs against every row, including the one the user just added
    // and hasn't filled in. Leaking "undefined undefined" or "NaN%" into the
    // grid is the most common way a naive script embarrasses itself.
    for (const s of RENDER_SAMPLES) {
      const out = runColumnScript(s.source, {});
      expect(out.ok).toBe(true);
      if (out.ok) expect(String(out.value), s.label).toBe('');
    }
  });
});

describe('each render sample computes what it says it does', () => {
  it('Join two fields', () => {
    expect(render('Join two fields into one', { first: 'Ada', last: 'Lovelace' })).toBe('Ada Lovelace');
    // A half-filled row gives the one field, not "Ada undefined".
    expect(render('Join two fields into one', { first: 'Ada' })).toBe('Ada');
  });

  it('Markdown → formatted text, via the markdownToHtml helper', () => {
    expect(render('Markdown → formatted text (markdownToHtml)', { notes: '**bold**' })).toBe('<p><strong>bold</strong></p>');
    // The helper sanitises rather than escapes: formatting in the data
    // survives, anything that could execute does not.
    expect(render('Markdown → formatted text (markdownToHtml)', { notes: 'a <b>bold</b> word' })).toContain('<b>bold</b>');
    expect(render('Markdown → formatted text (markdownToHtml)', { notes: '<script>x</script>' })).not.toContain('script');
  });

  it('Markdown summary takes the first line and bolds the title', () => {
    const out = render('Markdown summary — first line, bolded label', { title: 'Q3', notes: 'first line\nsecond line' });
    expect(out).toContain('<strong>Q3</strong>');
    expect(out).toContain('first line');
    expect(out).not.toContain('second line');
  });

  it('Build a URL from a field', () => {
    expect(render('Build a URL from a field', { repo: 'cawoodm' })).toBe('https://github.com/cawoodm');
    expect(render('Build a URL from a field', {})).toBe('');
  });

  it('Build a URL with query parameters — and encode them', () => {
    const out = String(render('Build a URL with query parameters', { street: 'Bahnhofstrasse 1', city: 'Zürich' }));
    expect(out.startsWith('https://www.openstreetmap.org/search?query=')).toBe(true);
    expect(out).toContain('Bahnhofstrasse+1');
    expect(out).not.toContain(' ');
  });

  it('Mailto link carries an encoded subject', () => {
    const out = String(render('Mailto link with a prefilled subject', { email: 'marc@monads.ch', title: 'Offer & terms' }));
    expect(out).toBe('mailto:marc@monads.ch?subject=Re%3A%20Offer%20%26%20terms');
  });

  it('Line total multiplies quantity by price', () => {
    expect(render('Maths — line total (quantity × price)', { qty: 3, price: 4.5 })).toBe('13.50');
    // Strings out of a text cell still multiply.
    expect(render('Maths — line total (quantity × price)', { qty: '2', price: '10' })).toBe('20.00');
    expect(render('Maths — line total (quantity × price)', { qty: 'x', price: 1 })).toBe('');
    // Half a line is not a total — blank beats a misleading 0.00.
    expect(render('Maths — line total (quantity × price)', { qty: 2 })).toBe('');
  });

  it('Money formatting uses the locale and currency in the sample', () => {
    const out = String(render('Maths — amount as money (Intl.NumberFormat)', { amount: 1234.5 }));
    expect(out).toContain('CHF');
    expect(out).toMatch(/1.234[.,]50/); // grouping/decimal glyphs are locale data
    expect(render('Maths — amount as money (Intl.NumberFormat)', { amount: 'n/a' })).toBe('');
  });

  it('Percentage rounds, and refuses to divide by zero', () => {
    expect(render('Maths — percentage of a total', { done: 3, total: 4 })).toBe('75%');
    expect(render('Maths — percentage of a total', { done: 1, total: 3 })).toBe('33%');
    expect(render('Maths — percentage of a total', { done: 5, total: 0 })).toBe('');
  });

  it('Days between a date and today reads in both directions', () => {
    const inDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const L = 'Days between a date and today';
    expect(render(L, { due: inDays(3) })).toBe('in 3 days');
    expect(render(L, { due: inDays(-3) })).toBe('3 days ago');
    // Whole days, so a date-only value reads the same all day long.
    expect(render(L, { due: inDays(0) })).toBe('today');
    expect(render(L, { due: 'not a date' })).toBe('');
  });
});
