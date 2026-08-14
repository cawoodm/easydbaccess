import { describe, expect, it } from 'vitest';
import { isRefreshable, PANEL_COLORS, PANEL_COLOR_LOCAL, panelColor, tableKind } from '../../../packages/renderer/src/window-mgr/table-kind.js';

describe('tableKind', () => {
  it('is "normal" for a plain table with neither source nor origin', () => {
    expect(tableKind({})).toBe('normal');
    expect(tableKind({ source: undefined, origin: undefined })).toBe('normal');
  });

  it('is "imported" for a snapshot table (origin set, no source)', () => {
    expect(tableKind({ origin: { type: 'datasette', url: 'https://x/y' } })).toBe('imported');
  });

  it('is "referenced" when source.type is exactly "url"', () => {
    expect(tableKind({ source: { type: 'url', config: {} } })).toBe('referenced');
  });

  it('is "connected" when source.type is "datasette"', () => {
    expect(tableKind({ source: { type: 'datasette', config: {} } })).toBe('connected');
  });

  it('is "connected" for any future non-"url" source.type (treat unknown as connected)', () => {
    expect(tableKind({ source: { type: 'some-future-backend', config: {} } })).toBe('connected');
  });

  // A table with BOTH `source` and `origin` classifies as the `source` kind:
  // live routing (routed-data-store.ts) always reads from `source` when
  // present, regardless of how the table originally arrived, so `source` wins.
  it('prefers `source` over `origin` when both are present', () => {
    expect(
      tableKind({
        source: { type: 'datasette', config: {} },
        origin: { type: 'datasette', url: 'https://x/y' },
      }),
    ).toBe('connected');
    expect(
      tableKind({
        source: { type: 'url', config: {} },
        origin: { type: 'csv', url: 'https://x/y' },
      }),
    ).toBe('referenced');
  });
});

describe('isRefreshable', () => {
  it('is false for a plain table', () => {
    expect(isRefreshable({})).toBe(false);
  });

  it('is true whenever source or origin is present', () => {
    expect(isRefreshable({ origin: { type: 'csv', url: 'https://x/y' } })).toBe(true);
    expect(isRefreshable({ source: { type: 'url', config: {} } })).toBe(true);
    expect(isRefreshable({ source: { type: 'datasette', config: {} } })).toBe(true);
  });
});

describe('panelColor', () => {
  it('gives each kind its own shade', () => {
    expect(panelColor({})).toBe(PANEL_COLORS.normal);
    expect(panelColor({ origin: { type: 'csv', url: 'https://x/y' } })).toBe(PANEL_COLORS.imported);
    expect(panelColor({ source: { type: 'url', config: {} } })).toBe(PANEL_COLORS.referenced);
    expect(panelColor({ source: { type: 'datasette', config: {} } })).toBe(PANEL_COLORS.connected);
    expect(panelColor({ source: { type: 'projection', config: {} } })).toBe(PANEL_COLORS.projection);
  });

  it('every kind is a shade of BLUE — a table always looks like a table', () => {
    // Non-blue is reserved for what is not a table: teal for a view, violet for
    // a visualization. Violet used to mean "refreshable table" AND "chart",
    // which is why this is asserted rather than left to the eye.
    for (const [kind, hex] of Object.entries(PANEL_COLORS)) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
      expect(b, `${kind} ${hex} should be blue-dominant`).toBeGreaterThan(r);
      expect(b, `${kind} ${hex} should be blue-dominant`).toBeGreaterThan(g);
    }
  });

  it('no two kinds share a shade — the whole point is telling them apart', () => {
    const shades = Object.values(PANEL_COLORS);
    expect(new Set(shades).size).toBe(shades.length);
  });

  it('is the one thing a window and its dock bar both paint from', () => {
    // Not a CSS class over the window: that is what made a minimized window
    // change colour.
    expect(PANEL_COLOR_LOCAL).toBe(PANEL_COLORS.normal);
  });
});
