import { afterEach, describe, expect, it } from 'vitest';
import {
  DANGEROUS_SCHEMES,
  DEFAULT_PROTOCOLS,
  isBareLink,
  NO_AUTHORITY_SCHEMES,
  parseProtocolPolicy,
  schemeAllowed,
  schemeOf,
  setProtocolPolicy,
  urlAllowed,
} from '../../../packages/renderer/src/util/url-schemes.js';
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

describe('urlAllowed, with the shipped default policy', () => {
  it('refuses the three that execute', () => {
    expect(urlAllowed('javascript:alert(1)')).toBe(false);
    expect(urlAllowed('vbscript:msgbox')).toBe(false);
    expect(urlAllowed('data:text/html;base64,PHN2Zz4=')).toBe(false);
  });

  it('is case- and space-blind, because the browser is', () => {
    expect(urlAllowed('  JavaScript:alert(1)')).toBe(false);
  });

  it('lets every other scheme through', () => {
    for (const url of ['https://x.dev', 'file:///c:/x.html', 'ftp://host/f', 'mailto:a@b.dev', 'obsidian://open?vault=v', 'ms-excel:ofe|u|https://x.dev/b.xlsx']) {
      expect(urlAllowed(url), url).toBe(true);
    }
  });
});

/**
 * The list is a SETTING (`links:protocols`). A plain list is exhaustive; the same
 * list behind `!` says what to refuse and allows the rest.
 */
describe('parseProtocolPolicy', () => {
  it('reads a list as an allow-list', () => {
    const p = parseProtocolPolicy('http,https,ftp,file');
    expect(p.deny).toBe(false);
    expect([...p.schemes].sort()).toEqual(['file', 'ftp', 'http', 'https']);
  });

  it('reads a leading ! as a deny-list', () => {
    const p = parseProtocolPolicy('!javascript,vbscript');
    expect(p.deny).toBe(true);
    expect([...p.schemes].sort()).toEqual(['javascript', 'vbscript']);
  });

  it('takes the field however it was typed', () => {
    // Commas, spaces, semicolons and pipes all separate; a scheme may arrive
    // spelled as a URL prefix; case is not significant.
    const p = parseProtocolPolicy(' HTTP://  https: ; ftp | file ');
    expect([...p.schemes].sort()).toEqual(['file', 'ftp', 'http', 'https']);
  });

  it('drops what is not a scheme rather than failing the line', () => {
    expect([...parseProtocolPolicy('http, 3, ??, https').schemes].sort()).toEqual(['http', 'https']);
  });

  it('falls back to the default for an empty field', () => {
    for (const text of ['', '   ', null, undefined]) {
      expect(parseProtocolPolicy(text)).toEqual(parseProtocolPolicy(DEFAULT_PROTOCOLS));
    }
  });

  it('falls back for an allow-list of nothing — a typo must not silence every link', () => {
    expect(parseProtocolPolicy(',,').deny).toBe(true);
    expect(parseProtocolPolicy('://').deny).toBe(true);
  });

  it('keeps a deny-list of nothing, which is a real answer: refuse nothing', () => {
    const p = parseProtocolPolicy('!');
    expect(p.deny).toBe(true);
    expect(p.schemes.size).toBe(0);
    expect(schemeAllowed('javascript', p)).toBe(true);
  });
});

describe('the policy in force', () => {
  afterEach(() => setProtocolPolicy(null));

  it('an allow-list refuses everything it does not name', () => {
    setProtocolPolicy(parseProtocolPolicy('http,https,ftp,file'));
    expect(safeUrl('file:///C:/x.html')).toBe('file:///C:/x.html');
    expect(safeUrl('ftp://host/f')).toBe('ftp://host/f');
    // Allowed by the default policy, and not on this list.
    expect(safeUrl('obsidian://open?vault=v')).toBeNull();
    expect(safeUrl('mailto:a@b.dev')).toBeNull();
  });

  it('reaches the Link renderer and the bare-URL rule too, not just the sanitizer', () => {
    setProtocolPolicy(parseProtocolPolicy('http,https'));
    expect(detectLink('file:///C:/x.html')).toBeNull();
    expect(isBareLink('file:///C:/x.html')).toBe(false);
    expect(detectLink('https://x.dev')).not.toBeNull();
  });

  it('honours a deny-list that no longer names data:', () => {
    // The user's call, and the field says what it costs.
    setProtocolPolicy(parseProtocolPolicy('!javascript,vbscript'));
    expect(safeUrl('data:text/html,x')).toBe('data:text/html,x');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
  });

  it('leaves URLs with no scheme alone whatever the list says', () => {
    setProtocolPolicy(parseProtocolPolicy('mailto'));
    expect(safeUrl('/a/b')).toBe('/a/b');
    expect(safeUrl('#section')).toBe('#section');
  });

  it('setProtocolPolicy(null) is back to the default', () => {
    setProtocolPolicy(parseProtocolPolicy('mailto'));
    setProtocolPolicy(null);
    expect(safeUrl('file:///C:/x.html')).toBe('file:///C:/x.html');
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
