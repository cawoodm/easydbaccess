import { describe, it, expect } from 'vitest';
import { pillChipClass, pillFieldLabel } from '../../../packages/renderer/src/views/pill-chip.js';

describe('pillChipClass', () => {
  it('is the bare chip class when the value is ON (the active filter)', () => {
    expect(pillChipClass('on')).toBe('eda-pill-chip');
  });

  it('adds "not" when the value is EXCLUDED', () => {
    expect(pillChipClass('not')).toBe('eda-pill-chip not');
  });

  it('adds "off" when nothing filters on this value', () => {
    expect(pillChipClass('off')).toBe('eda-pill-chip off');
  });
});

describe('pillFieldLabel', () => {
  it('shows the bare field name when idle — there is no operator to show', () => {
    expect(pillFieldLabel('tag', 'off')).toBe('tag');
  });

  it('shows "field =" when the value is the active filter', () => {
    expect(pillFieldLabel('tag', 'on')).toBe('tag =');
  });

  it('shows "field ≠" when the value is excluded', () => {
    expect(pillFieldLabel('tag', 'not')).toBe('tag ≠');
  });
});
