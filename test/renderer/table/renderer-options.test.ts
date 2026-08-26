import { describe, expect, it } from 'vitest';
import { offerableRenderers, rendererOptionsFor } from '../../../packages/renderer/src/table/renderer-options.js';
import { LEGACY_CELL_RENDERERS } from '../../../packages/renderer/src/plugin-host/registries.js';

/**
 * What a renderer picker offers.
 *
 * Two pickers ask — the table's columns editor and a view's own — and an answer
 * that differed between them would read as one of the two being broken.
 */

const registry = (...names: string[]) => new Map(names.map((n) => [n, `cell-${n}`]));

describe('offerableRenderers', () => {
  it('is sorted, so the list does not depend on plugin load order', () => {
    expect(offerableRenderers(registry('link', 'boolean', 'markdown'))).toEqual(['boolean', 'link', 'markdown']);
  });

  it('leaves out legacy aliases: they still work, but are not what a new choice is called', () => {
    const legacy = [...LEGACY_CELL_RENDERERS][0];
    expect(legacy).toBeTruthy();
    expect(offerableRenderers(registry('link', legacy!))).toEqual(['link']);
  });

  it('is empty before any renderer plugin has registered', () => {
    expect(offerableRenderers(new Map())).toEqual([]);
  });
});

describe('rendererOptionsFor', () => {
  it('is the offered list when the column already uses one of them', () => {
    expect(rendererOptionsFor(['link', 'markdown'], 'link')).toEqual(['link', 'markdown']);
  });

  it('keeps a renderer nothing offers any more, so saving cannot drop it', () => {
    // A column stored under a legacy or since-removed renderer would otherwise
    // show the empty option while still having one.
    expect(rendererOptionsFor(['link'], 'html-preview')).toEqual(['link', 'html-preview']);
  });

  it('adds nothing for a column with no renderer', () => {
    expect(rendererOptionsFor(['link'], undefined)).toEqual(['link']);
    expect(rendererOptionsFor(['link'], '')).toEqual(['link']);
  });
});
