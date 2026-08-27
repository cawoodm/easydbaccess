import { describe, expect, it } from 'vitest';
import { fileLinkMessage, pageRefusesLink, startFileLinkGuard } from '../../../packages/renderer/src/util/file-link-guard.js';

/**
 * A page served over http(s) is not allowed to navigate to `file:`, and with
 * `target="_blank"` the browser answers by opening a tab showing
 * `about:blank#blocked`. The guard catches the click first. The desktop app's own
 * page IS `file:`, so there it stands aside.
 */

describe('pageRefusesLink', () => {
  it('is true for a local file from a web page', () => {
    expect(pageRefusesLink('file:///C:/projects/file.html', 'http:')).toBe(true);
    expect(pageRefusesLink('file:///C:/projects/file.html', 'https:')).toBe(true);
    expect(pageRefusesLink('FILE:///C:/x.html', 'https:')).toBe(true);
  });

  it('is false in the desktop app, whose page is file: itself', () => {
    expect(pageRefusesLink('file:///C:/projects/file.html', 'file:')).toBe(false);
  });

  it('leaves every other scheme to the browser', () => {
    // These hand off to another app, or navigate normally. Either way the browser
    // does not strand the user on a blank tab, so there is nothing to intercept.
    for (const href of ['https://x.dev', 'ftp://host/f', 'mailto:a@b.dev', 'obsidian://open?vault=v', '/a/b', '#section', '']) {
      expect(pageRefusesLink(href, 'https:'), href).toBe(false);
    }
  });
});

describe('fileLinkMessage', () => {
  it('says where the path went when the clipboard took it', () => {
    expect(fileLinkMessage('file:///C:/x.html', true)).toContain('clipboard');
  });

  it('names the path when it did not, so it is still readable', () => {
    const msg = fileLinkMessage('file:///C:/x.html', false);
    expect(msg).toContain('file:///C:/x.html');
    expect(msg).not.toContain('clipboard');
  });

  it('always names the way that works', () => {
    for (const copied of [true, false]) {
      expect(fileLinkMessage('file:///C:/x.html', copied)).toContain('desktop app');
    }
  });
});

describe('startFileLinkGuard', () => {
  it('is a no-op without a document, and its stop is safe to call', () => {
    // Plain Node here — the guard must not be what breaks a headless import.
    const stop = startFileLinkGuard(() => {});
    expect(() => stop()).not.toThrow();
  });
});
