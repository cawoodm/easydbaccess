import { describe, expect, it } from 'vitest';
import { isRefreshable, tableKind } from '../../../packages/renderer/src/window-mgr/table-kind.js';

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
