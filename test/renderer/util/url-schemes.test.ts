import { describe, expect, it } from 'vitest';
import { DANGEROUS_SCHEMES, isBareLink, NO_AUTHORITY_SCHEMES, runsScript, schemeOf } from '../../../packages/renderer/src/util/url-schemes.js';
import { safeUrl } from '../../../packages/renderer/src/util/sanitize-html.js';
import { detectLink } from '../../../packages/renderer/src/plugins/link-detect.js';

/**
 * One rule for which URL schemes may be clicked.
 *
 * There were two. The Link cell renderer allowed any scheme except the ones that
 * RUN something (v0.0.438), while the HTML sanitizer behind markdown and view
 * templates kept an allow-list of http/https/mailto/tel — so the same
 * `file:///C:/notes.html` was a link in a Link column and plain text in a
 * Markdown one.
 */

describe('schemeOf', () => {
  it('lower-cases the scheme', () => {
    expect(schemeOf('HTTPS://x.dev')).toBe('https');
    expect(schemeOf('File:///c:/x')).toBe('file');
  });

  it('is null for anything carrying no scheme', () => {
    expect(schemeOf('/absolute/path')).toBeNull();
    expect(schemeOf('relative/path')).toBeNull();
    expect(schemeOf('#fragment')).toBeNull();
    expect(schemeOf('//host/path')).toBeNull();
  });
});

describe('runsScript', () => {
  it('names the three that execute', () => {
    expect(runsScript('javascript:alert(1)')).toBe(true);
    expect(runsScript('vbscript:msgbox')).toBe(true);
    expect(runsScript('data:text/html;base64,PHN2Zz4=')).toBe(true);
  });

  it('is case- and space-blind, because the browser is', () => {
    expect(runsScript('  JavaScript:alert(1)')).toBe(true);
  });

  it('lets every other scheme through', () => {
    for (const url of ['https://x.dev', 'file:///c:/x.html', 'ftp://host/f', 'mailto:a@b.dev', 'obsidian://open?vault=v', 'ms-excel:ofe|u|https://x.dev/b.xlsx']) {
      expect(runsScript(url), url).toBe(false);
    }
  });
});

describe('safeUrl', () => {
  it('now accepts any scheme that does not execute', () => {
    expect(safeUrl('file:///C:/projects/file.html')).toBe('file:///C:/projects/file.html');
    expect(safeUrl('ftp://host/f')).toBe('ftp://host/f');
    expect(safeUrl('obsidian://open?vault=v')).toBe('obsidian://open?vault=v');
  });

  it('still refuses the ones that do', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html;base64,PHN2Zz4=')).toBeNull();
    expect(safeUrl('vbscript:msgbox')).toBeNull();
  });

  it('still passes paths and fragments through untouched', () => {
    expect(safeUrl('/a/b')).toBe('/a/b');
    expect(safeUrl('#Genesis%202')).toBe('#Genesis%202');
    expect(safeUrl('//cdn.host/x.png')).toBe('//cdn.host/x.png');
  });

  it('is null for nothing at all', () => {
    expect(safeUrl('')).toBeNull();
    expect(safeUrl('   ')).toBeNull();
  });
});

describe('isBareLink', () => {
  it('takes a scheme with an authority', () => {
    expect(isBareLink('https://x.dev')).toBe(true);
    expect(isBareLink('file:///C:/notes.html')).toBe(true);
    expect(isBareLink('ftp://host/f')).toBe(true);
  });

  it('takes the few schemes that are real without one', () => {
    expect(isBareLink('mailto:a@b.dev')).toBe(true);
    expect(isBareLink('tel:+41791234567')).toBe(true);
  });

  it('leaves prose alone — this is the whole reason it is stricter than safeUrl', () => {
    // `safeUrl` would happily accept every one of these as a link TARGET. The
    // question here is whether the author meant a link, and they did not.
    for (const text of ['TODO:fix this', 'Note:call back', 'ratio 3:4', 'C:/Users/marc']) {
      expect(isBareLink(text), text).toBe(false);
    }
  });

  it('refuses the executable schemes even written with an authority', () => {
    expect(isBareLink('javascript://x/alert(1)')).toBe(false);
    expect(isBareLink('data://x')).toBe(false);
  });

  it('refuses a scheme with nothing after it', () => {
    expect(isBareLink('https://')).toBe(false);
    expect(isBareLink('mailto:')).toBe(false);
  });
});

describe('the two rules agree', () => {
  it('a value the Link renderer links is a URL the sanitizer accepts', () => {
    for (const v of ['https://x.dev', 'file:///C:/notes.html', 'ftp://host/f', 'mailto:a@b.dev', 'obsidian://open?vault=v']) {
      expect(detectLink(v), v).not.toBeNull();
      expect(safeUrl(v), v).not.toBeNull();
    }
  });

  it('and one it refuses on safety grounds is refused by both', () => {
    for (const v of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:msgbox']) {
      expect(detectLink(v), v).toBeNull();
      expect(safeUrl(v), v).toBeNull();
    }
  });

  it('the sets are the ones both sides import, not copies', () => {
    expect([...DANGEROUS_SCHEMES].sort()).toEqual(['data', 'javascript', 'vbscript']);
    expect(NO_AUTHORITY_SCHEMES.has('mailto')).toBe(true);
  });
});
