// Every sample the script editor offers is real code the user can save
// unchanged, so the suite treats them as code: each one must compile, must
// accept the value it advertises, and must reject the value it exists to
// catch. A typo in a sample is otherwise only found by the person who picked
// it and got a "compile error" instead of a validation rule.

import { describe, expect, it } from 'vitest';
import { VALIDATE_SAMPLES } from '../../../packages/renderer/src/dialogs/validate-samples.js';
import { runValidateScript } from '../../../packages/renderer/src/util/column-script.js';

/** Run a sample by label — fails loudly if the label ever drifts. */
function run(label: string, value: unknown, row: Record<string, unknown> = {}) {
  const sample = VALIDATE_SAMPLES.find((s) => s.label === label);
  if (!sample) throw new Error(`no sample labelled "${label}"`);
  return runValidateScript(sample.source, value, row);
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
