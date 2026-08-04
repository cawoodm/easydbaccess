import { describe, it, expect } from 'vitest';
import { looksLikeHtml, htmlToPreviewText } from '../../../packages/renderer/src/util/html-text.js';

describe('looksLikeHtml', () => {
  it('recognizes real markup', () => {
    expect(looksLikeHtml('<p>hi</p>')).toBe(true);
    expect(looksLikeHtml('</div>')).toBe(true);
    expect(looksLikeHtml('<br/>')).toBe(true);
    expect(looksLikeHtml('x &amp; y')).toBe(true);
    expect(looksLikeHtml('&#39;')).toBe(true);
  });

  it('treats plain text with bare angle brackets/ampersands as non-HTML', () => {
    expect(looksLikeHtml('a < b')).toBe(false);
    expect(looksLikeHtml('5 > 3')).toBe(false);
    expect(looksLikeHtml('plain text')).toBe(false);
    expect(looksLikeHtml('')).toBe(false);
    expect(looksLikeHtml('line one\nline two\nline three')).toBe(false);
    expect(looksLikeHtml('2 < 3 && 4 > 1')).toBe(false);
  });
});

describe('htmlToPreviewText', () => {
  it('collapses newlines/whitespace for a plain-text value', () => {
    expect(htmlToPreviewText('line one\nline two\n  line three')).toBe('line one line two line three');
  });

  it('collapses whitespace for an HTML value by stripping tags', () => {
    expect(htmlToPreviewText('<p>line one</p>\n<p>line two</p>')).toBe('line one line two');
  });

  it('keeps a plain-text bare "<" intact instead of losing it to tag parsing', () => {
    expect(htmlToPreviewText('a <b c')).toBe('a <b c');
  });
});
