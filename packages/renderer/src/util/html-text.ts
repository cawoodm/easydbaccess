/**
 * Plain-text vs. HTML detection for cell renderers that need to display a
 * value's text safely, without mangling plain text that merely contains a
 * bare `<` or `>` (e.g. `a < b`).
 *
 * A value is only treated as HTML if it plausibly contains real markup: an
 * open tag (`<tag ...>`), a close tag (`</tag>`), or a named/numeric entity
 * (`&amp;`, `&#39;`). Anything else — including comparisons like `2 < 3` —
 * is plain text.
 */

import { decodeEntities } from './sanitize-html.js';

/** Matches a real open tag, close tag, or entity — not a bare `<`/`>`/`&`. */
const HTML_LIKE = /<\/?[a-z][a-z0-9]*(\s[^<>]*)?\/?>|&[a-z][a-z0-9]*;|&#\d+;|&#x[0-9a-f]+;/i;

/** True when `s` plausibly contains HTML markup (a tag or an entity). */
export function looksLikeHtml(s: string): boolean {
  return HTML_LIKE.test(s);
}

/**
 * Strip tags → plain text. Uses the DOM's own HTML parser
 * (`innerHTML`/`textContent`) when `document` is available — the exact
 * mechanism this renderer has always used, so browser/e2e behaviour is
 * unchanged. Falls back to a regex-based approximation in DOM-less
 * environments (this package's vitest setup runs without jsdom/happy-dom).
 */
function stripTagsToText(html: string): string {
  if (typeof document !== 'undefined') {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent ?? '';
  }
  return decodeEntities(html.replace(/<[^>]*>/g, ''));
}

/**
 * Collapsed one-line preview of `value`. HTML values are tag-stripped
 * first; plain-text values are used as-is — either way the result is
 * whitespace-collapsed on the resulting string. Plain text never round-trips
 * through `innerHTML`, so a value like `a <b c` keeps its `<b c` intact
 * instead of losing it to bogus tag parsing.
 */
export function htmlToPreviewText(value: string): string {
  const text = looksLikeHtml(value) ? stripTagsToText(value) : value;
  return text.replace(/\s+/g, ' ').trim();
}
