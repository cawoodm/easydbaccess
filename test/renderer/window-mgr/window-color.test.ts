import { afterEach, describe, expect, it } from 'vitest';
import {
  choiceForColor,
  colorForChoice,
  DEFAULT_WINDOW_COLOR_LIST,
  isWindowColor,
  PALETTE_ICON,
  parseWindowColors,
  setWindowColors,
  windowColorKey,
  windowColors,
  WINDOW_COLORS,
} from '../../../packages/renderer/src/window-mgr/window-color.js';

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

/**
 * The list is a setting: hex values or HTML colour names, comma-separated. The
 * shipped nine are the default, and stay the default whenever the setting says
 * nothing usable — there is no way to end up with a picker offering only "Kind".
 */
describe('parseWindowColors', () => {
  it('reads a comma-separated list, in the order given', () => {
    const list = parseWindowColors('#FF00DD,red,blue');
    expect(list.map((c) => c.value)).toEqual([null, '#FF00DD', 'red', 'blue']);
  });

  it('always leads with the default entry, whatever the setting says', () => {
    expect(parseWindowColors('red')[0]).toEqual(WINDOW_COLORS[0]);
  });

  it('accepts spaces and new lines as separators too', () => {
    expect(parseWindowColors('red blue\ngreen').map((c) => c.value)).toEqual([null, 'red', 'blue', 'green']);
  });

  it('names a hex by its value and a colour name by its name', () => {
    const list = parseWindowColors('#ff00dd,rebeccapurple');
    expect(list.map((c) => c.label)).toEqual(['Default for this kind', '#FF00DD', 'Rebeccapurple']);
  });

  it('keeps a shipped colour’s own name and id wherever it appears in the list', () => {
    // So a window already painted #15803d still shows as the current one, and
    // the swatch is still called "Green" rather than "#15803D".
    const list = parseWindowColors('red,#15803d');
    expect(list[2]).toEqual({ id: 'green', label: 'Green', value: '#15803d' });
  });

  it('DROPS an entry that is not a colour instead of refusing the list', () => {
    // One typo in a one-line field must not cost the user the other colours.
    const list = parseWindowColors('red,notacolour!,blue');
    expect(list.map((c) => c.value)).toEqual([null, 'red', 'blue']);
  });

  it('drops a repeat, however it is capitalised', () => {
    expect(parseWindowColors('#ABCDEF,red,#abcdef').map((c) => c.value)).toEqual([null, '#ABCDEF', 'red']);
  });

  it('gives every entry its own id, even when two mean the same shipped name', () => {
    // `red` is CSS red and `#b91c1c` is the shipped "Red" — two colours, one name.
    const ids = parseWindowColors('red,#b91c1c').map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('falls back to the shipped list for an empty setting', () => {
    expect(parseWindowColors('')).toBe(WINDOW_COLORS);
    expect(parseWindowColors(null)).toBe(WINDOW_COLORS);
    expect(parseWindowColors(undefined)).toBe(WINDOW_COLORS);
  });

  it('falls back to the shipped list when nothing in the setting is a colour', () => {
    expect(parseWindowColors('nope,,,!!!')).toBe(WINDOW_COLORS);
  });

  it('round-trips the shipped list, so the field opens on what it already does', () => {
    expect(parseWindowColors(DEFAULT_WINDOW_COLOR_LIST)).toEqual(WINDOW_COLORS);
  });
});

describe('isWindowColor', () => {
  it('takes hex in every length CSS allows', () => {
    for (const v of ['#abc', '#abcd', '#a1b2c3', '#a1b2c3d4']) expect(isWindowColor(v), v).toBe(true);
  });

  it('takes an HTML colour name, in any case', () => {
    for (const v of ['red', 'Blue', 'REBECCAPURPLE', 'cornflowerblue']) expect(isWindowColor(v), v).toBe(true);
  });

  it('refuses what is not a colour', () => {
    for (const v of ['#ab', '#abcde', 'rgb(1,2,3)', '12345', 'red;blue', 'nope', 'burgundy', '']) expect(isWindowColor(v), v).toBe(false);
  });

  it('refuses the keywords that paint nothing', () => {
    // Each one gives an invisible swatch and a titlebar that looks broken.
    for (const v of ['transparent', 'currentColor', 'inherit', 'unset', 'none']) expect(isWindowColor(v), v).toBe(false);
  });
});

describe('the live list', () => {
  afterEach(() => setWindowColors(null));

  it('is the shipped one until something sets it', () => {
    expect(windowColors()).toBe(WINDOW_COLORS);
  });

  it('is what colorForChoice and choiceForColor read', () => {
    setWindowColors(parseWindowColors('#FF00DD,red'));
    expect(colorForChoice('ff00dd')).toBe('#FF00DD');
    expect(choiceForColor('#ff00dd')).toBe('ff00dd');
    // A shipped colour the user's list leaves out is "custom" — a window already
    // painted with it keeps it, but no swatch is ringed.
    expect(choiceForColor('#15803d')).toBe('custom');
    expect(colorForChoice('green')).toBeUndefined();
  });

  it('cannot be emptied down to the default entry alone', () => {
    setWindowColors([WINDOW_COLORS[0]!]);
    expect(windowColors()).toBe(WINDOW_COLORS);
    setWindowColors(null);
    expect(windowColors()).toBe(WINDOW_COLORS);
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
