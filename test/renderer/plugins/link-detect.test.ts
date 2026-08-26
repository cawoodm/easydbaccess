import { describe, expect, it } from 'vitest';
import { detectLink, isLinkValue, linkTitle } from '../../../packages/renderer/src/plugins/link-detect.js';

/**
 * Which cell values are links.
 *
 * The renderer took `http://` and `https://` only. Any scheme counts now —
 * `file:///` above all — so most of these tests are about what must NOT become a
 * link: a script scheme somebody else's workspace brought in, and prose that
 * happens to contain a colon.
 */

describe('detectLink', () => {
  it('takes the two web schemes it always took', () => {
    expect(detectLink('https://example.org')?.href).toBe('https://example.org');
    expect(detectLink('http://example.org/a?b=1#c')?.href).toBe('http://example.org/a?b=1#c');
  });

  it('takes file:// — the case this was opened for', () => {
    const link = detectLink('file:///C:/reports/june.pdf');
    expect(link?.href).toBe('file:///C:/reports/june.pdf');
    expect(link?.scheme).toBe('file');
    expect(link?.newTab).toBe(true);
  });

  it('takes any other scheme with an authority', () => {
    for (const v of ['ftp://files.example.org/x', 'obsidian://open?vault=notes', 'vscode://file/c:/x', 'slack://channel?id=C1', 's3://bucket/key']) {
      expect(isLinkValue(v)).toBe(true);
    }
  });

  it('takes the authority-less schemes that are real links', () => {
    expect(detectLink('mailto:ada@example.org')?.scheme).toBe('mailto');
    expect(detectLink('tel:+41791234567')?.scheme).toBe('tel');
    expect(detectLink('magnet:?xt=urn:btih:abc')?.scheme).toBe('magnet');
    // No `//`, so nothing to open in a tab — the browser hands these to an app.
    expect(detectLink('mailto:ada@example.org')?.newTab).toBe(false);
  });

  it('REFUSES a scheme that runs code', () => {
    // The reason "any scheme" needs a rule at all: cell values arrive from an
    // import, a sync pull or a workspace someone sent.
    expect(detectLink('javascript:alert(1)')).toBeNull();
    expect(detectLink('JavaScript:alert(1)')).toBeNull();
    expect(detectLink('vbscript:msgbox(1)')).toBeNull();
    expect(detectLink('data:text/html,<script>alert(1)</script>')).toBeNull();
    // Even with an authority, which is how a deny-list gets walked around.
    expect(detectLink('javascript://%0aalert(1)')).toBeNull();
  });

  it('leaves prose that happens to contain a colon alone', () => {
    // `word:something` is far more often a note than a URI.
    expect(detectLink('TODO:fix the header')).toBeNull();
    expect(detectLink('Note:callback')).toBeNull();
    expect(detectLink('ratio:16')).toBeNull();
    expect(detectLink('12:30')).toBeNull();
  });

  it('needs something after the scheme', () => {
    expect(detectLink('http://')).toBeNull();
    expect(detectLink('mailto:')).toBeNull();
    expect(detectLink('file:///')?.href).toBe('file:///');
  });

  it('needs the WHOLE cell to be the link', () => {
    // A sentence with a URL in it is prose; the grid cannot show half a cell as
    // a link.
    expect(detectLink('see https://example.org for more')).toBeNull();
    expect(detectLink('https://example.org and more')).toBeNull();
  });

  it('lets a file path keep its spaces, and encodes them in the href', () => {
    // The one exception, because local paths routinely have spaces. The label
    // stays as typed so the cell reads the way the user wrote it.
    const link = detectLink('file:///C:/My Documents/June Report.pdf');
    expect(link?.href).toBe('file:///C:/My%20Documents/June%20Report.pdf');
    expect(link?.label).toBe('file:///C:/My Documents/June Report.pdf');
  });

  it('trims, and reports the scheme lower-cased', () => {
    expect(detectLink('  https://example.org  ')?.label).toBe('https://example.org');
    expect(detectLink('HTTPS://EXAMPLE.ORG')?.scheme).toBe('https');
  });

  it('is null for what is plainly not a link', () => {
    for (const v of ['', '   ', 'not a link at all', 'ada@example.org', '+41 79 123 45 67', '42', 'C:/reports/june.pdf']) {
      expect(detectLink(v)).toBeNull();
    }
  });

  it('accepts a scheme with the punctuation RFC 3986 allows', () => {
    expect(isLinkValue('ms-word://open')).toBe(true);
    expect(isLinkValue('a+b://x')).toBe(true);
    // A scheme cannot start with a digit.
    expect(isLinkValue('2fast://x')).toBe(false);
  });
});

describe('linkTitle', () => {
  const file = detectLink('file:///C:/x.pdf')!;

  it('warns that a browser tab cannot open a local file', () => {
    // The click is refused silently and only the console says why, so the
    // tooltip is where the reader finds out.
    expect(linkTitle(file, 'http:')).toContain('cannot open a local file');
  });

  it('says nothing of the sort in the desktop app, where it works', () => {
    // The packaged app loads the renderer from `file:` itself.
    expect(linkTitle(file, 'file:')).toBe('Open file:///C:/x.pdf');
  });

  it('names the action for the hand-off schemes', () => {
    expect(linkTitle(detectLink('mailto:ada@example.org')!, 'http:')).toBe('Email mailto:ada@example.org');
    expect(linkTitle(detectLink('tel:+41791234567')!, 'http:')).toBe('Call tel:+41791234567');
    expect(linkTitle(detectLink('https://example.org')!, 'http:')).toBe('Open https://example.org');
  });
});
