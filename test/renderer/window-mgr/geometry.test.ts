import { describe, expect, it } from 'vitest';
import type { WindowGeometry } from '@easydb/shared';
import { sanitizeGeometry, MIN_W, MIN_H } from '../../../packages/renderer/src/window-mgr/geometry.js';

const validGeometry = (overrides: Partial<WindowGeometry> = {}): WindowGeometry => ({
  x: 10,
  y: 20,
  w: 300,
  h: 200,
  z: 1,
  minimized: false,
  maximized: false,
  ...overrides,
});

describe('sanitizeGeometry', () => {
  it('returns null for undefined input', () => {
    expect(sanitizeGeometry(undefined)).toBeNull();
  });

  it('returns null for non-finite w', () => {
    expect(sanitizeGeometry(validGeometry({ w: Infinity }))).toBeNull();
    expect(sanitizeGeometry(validGeometry({ w: NaN }))).toBeNull();
  });

  it('returns null for non-finite h', () => {
    expect(sanitizeGeometry(validGeometry({ h: Infinity }))).toBeNull();
    expect(sanitizeGeometry(validGeometry({ h: NaN }))).toBeNull();
  });

  it('returns null for non-finite x', () => {
    expect(sanitizeGeometry(validGeometry({ x: NaN }))).toBeNull();
    expect(sanitizeGeometry(validGeometry({ x: -Infinity }))).toBeNull();
  });

  it('returns null for non-finite y', () => {
    expect(sanitizeGeometry(validGeometry({ y: NaN }))).toBeNull();
    expect(sanitizeGeometry(validGeometry({ y: Infinity }))).toBeNull();
  });

  it('returns null when w is below the minimum', () => {
    expect(sanitizeGeometry(validGeometry({ w: MIN_W - 1 }))).toBeNull();
  });

  it('returns null when h is below the minimum', () => {
    expect(sanitizeGeometry(validGeometry({ h: MIN_H - 1 }))).toBeNull();
  });

  it('returns a valid geometry verbatim, as a copy (not the same reference)', () => {
    const g = validGeometry();
    const result = sanitizeGeometry(g);
    expect(result).toEqual(g);
    expect(result).not.toBe(g);
  });

  it('accepts off-screen negative x/y without clamping', () => {
    const g = validGeometry({ x: -5000, y: -5000 });
    expect(sanitizeGeometry(g)).toEqual(g);
  });
});
