import { describe, expect, it } from 'vitest';
import { choiceForColor, colorForChoice, PALETTE_ICON, windowColorKey, WINDOW_COLORS } from '../../../packages/renderer/src/window-mgr/window-color.js';

/**
 * A window's user-chosen titlebar colour.
 *
 * The automatic colour says what a window IS — every table a shade of blue, a
 * view teal, a visualization violet. An override says which one it is, which is
 * the question once a workspace holds fifteen of them.
 */

describe('windowColorKey', () => {
  it('is one settings key per window', () => {
    expect(windowColorKey('tbl-1')).toBe('window-color:tbl-1');
    expect(windowColorKey('vi-1')).not.toBe(windowColorKey('tbl-1'));
  });
});

describe('WINDOW_COLORS', () => {
  it('leads with the default, which is the ABSENCE of a colour', () => {
    expect(WINDOW_COLORS[0]?.id).toBe('default');
    expect(WINDOW_COLORS[0]?.value).toBeNull();
  });

  it('offers distinct hues, not shades of one', () => {
    const values = WINDOW_COLORS.map((c) => c.value).filter((v): v is string => !!v);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is readable: every colour clears WCAG AA against the white titlebar text', () => {
    for (const c of WINDOW_COLORS) {
      if (!c.value) continue;
      expect(contrastWithWhite(c.value), `${c.label} (${c.value})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('does not offer the kind blues — a view painted table-blue would lie', () => {
    // `table-kind.ts`'s PANEL_COLORS. Duplicated rather than imported: the point
    // is that these two lists must not converge, so a shared constant would
    // defeat the check.
    const kinds = ['#01579b', '#0277bd', '#1565c0', '#0d47a1', '#3949ab'];
    for (const c of WINDOW_COLORS) {
      if (c.value) expect(kinds).not.toContain(c.value.toLowerCase());
    }
  });

  it('has a stable id per entry, since the id is what the menu returns', () => {
    const ids = WINDOW_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('colorForChoice', () => {
  it('maps a menu id to its colour', () => {
    expect(colorForChoice('green')).toBe('#15803d');
  });

  it('maps the default to null — "follow this window’s kind"', () => {
    expect(colorForChoice('default')).toBeNull();
  });

  it('answers undefined for an id nothing offers, so the caller can do nothing', () => {
    // Distinguishable from `null`, which is a real choice.
    expect(colorForChoice('chartreuse')).toBeUndefined();
  });
});

describe('choiceForColor', () => {
  it('finds the entry a stored colour came from', () => {
    expect(choiceForColor('#15803d')).toBe('green');
  });

  it('is case-insensitive, because a stored value may be hand-edited', () => {
    expect(choiceForColor('#15803D')).toBe('green');
  });

  it('reads no colour as the default', () => {
    expect(choiceForColor(null)).toBe('default');
    expect(choiceForColor(undefined)).toBe('default');
    expect(choiceForColor('')).toBe('default');
  });

  it('calls a colour the list no longer offers "custom", not the default', () => {
    // An older build's colour must not be silently reset by opening the menu.
    expect(choiceForColor('#123456')).toBe('custom');
  });
});

describe('PALETTE_ICON', () => {
  it('paints from currentColor, so it reads on any titlebar it lands on', () => {
    expect(PALETTE_ICON).toContain('currentColor');
    expect(PALETTE_ICON).not.toMatch(/fill="#|stroke="#/);
  });
});

/** WCAG relative-luminance contrast of `hex` against white. */
function contrastWithWhite(hex: string): number {
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const l = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  return 1.05 / (l + 0.05);
}
