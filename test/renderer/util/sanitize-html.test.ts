import { describe, expect, it } from 'vitest';
import { sanitizeHtml } from '../../../packages/renderer/src/util/sanitize-html.js';

describe('sanitizeHtml: what it keeps', () => {
  // These are the tags an Atom-feed body is actually made of, counted over the
  // 571 rows of the simon-blog/entries table.
  it('keeps the formatting tags a feed body uses', () => {
    const src = '<p><strong><a href="https://x.dev/a">Title</a></strong></p>';
    expect(sanitizeHtml(src)).toBe('<p><strong><a href="https://x.dev/a" target="_blank" rel="noopener noreferrer">Title</a></strong></p>');
  });

  it('keeps a table, a list and a code block', () => {
    expect(sanitizeHtml('<table><tr><td colspan="2">a</td></tr></table>')).toBe('<table><tr><td colspan="2">a</td></tr></table>');
    expect(sanitizeHtml('<ul><li>a</li><li>b</li></ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(sanitizeHtml('<pre><code>x = 1</code></pre>')).toBe('<pre><code>x = 1</code></pre>');
  });

  it('keeps an image with a usable source, and the alt text', () => {
    expect(sanitizeHtml('<img src="https://x.dev/i.png" alt="a shot" width="40">')).toBe('<img src="https://x.dev/i.png" alt="a shot" width="40">');
  });

  it('keeps an entity as an entity, so the character shows and not its source', () => {
    expect(sanitizeHtml('a &amp; b &#8217;c&#8217;')).toBe('a &amp; b &#8217;c&#8217;');
  });

  it('escapes a naked ampersand and a comparison, which are not markup', () => {
    expect(sanitizeHtml('Tom & Jerry, 2 < 3')).toBe('Tom &amp; Jerry, 2 &lt; 3');
  });

  it('leaves a URL query string alone rather than re-encoding its ampersand', () => {
    expect(sanitizeHtml('<a href="https://x.dev/?a=1&amp;b=2">q</a>')).toContain('href="https://x.dev/?a=1&amp;b=2"');
  });
});

describe('sanitizeHtml: what it drops', () => {
  it('drops a script or style element together with its contents', () => {
    expect(sanitizeHtml('<p>a</p><script>alert(1)</script><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(sanitizeHtml('<style>body{display:none}</style>ok')).toBe('ok');
  });

  it('drops everything after an unclosed script, rather than guessing', () => {
    expect(sanitizeHtml('<p>a</p><script>alert(1)')).toBe('<p>a</p>');
  });

  it('drops an svg, which can carry its own script', () => {
    expect(sanitizeHtml('<svg onload="alert(1)"><circle/></svg>ok')).toBe('ok');
  });

  it('drops every event handler', () => {
    expect(sanitizeHtml('<img src="https://x.dev/i.png" onerror="alert(1)" onload="alert(2)">')).toBe('<img src="https://x.dev/i.png">');
    expect(sanitizeHtml('<p onmouseover="alert(1)">x</p>')).toBe('<p>x</p>');
  });

  it('drops class and style, which can collide with the app chrome', () => {
    expect(sanitizeHtml('<div class="dialog-header" style="position:fixed;inset:0">x</div>')).toBe('<div>x</div>');
  });

  it('drops an unknown tag but keeps the text it wrapped', () => {
    expect(sanitizeHtml('<marquee>still readable</marquee>')).toBe('still readable');
    expect(sanitizeHtml('<custom-thing a="b">text</custom-thing>')).toBe('text');
  });

  it('drops an HTML comment and a doctype', () => {
    expect(sanitizeHtml('<!-- hidden --><!DOCTYPE html><p>a</p>')).toBe('<p>a</p>');
  });
});

describe('sanitizeHtml: URLs', () => {
  it('drops a javascript: or data: URL', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<img src="data:text/html;base64,PHN2Zz4=">')).toBe('');
  });

  // The browser decodes the entity after the attribute is in the DOM, so the
  // scheme test has to decode it first. This one is the classic bypass.
  it('drops a javascript: URL hidden behind an entity or a control character', () => {
    expect(sanitizeHtml('<a href="javascript&#58;alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe('<a>x</a>');
    expect(sanitizeHtml('<a href=" JavaScript:alert(1)">x</a>')).toBe('<a>x</a>');
  });

  it('keeps http, https, mailto, tel and relative links', () => {
    for (const url of ['https://x.dev', 'http://x.dev', 'mailto:a@b.c', 'tel:+41791234567', '/docs/x.md', '#anchor']) {
      expect(sanitizeHtml(`<a href="${url}">x</a>`)).toContain(`href="${url}"`);
    }
  });

  // The `&quot;` stays an entity, and the text `onerror=` stays INSIDE the alt
  // value. A quoted attribute value is tokenized before its entities are
  // decoded, so an entity in it can never close the value and start a new
  // attribute. What must not happen is a raw `"` reaching the output.
  it('cannot be broken out of an attribute by a quote in the value', () => {
    const out = sanitizeHtml('<img src="https://x.dev/i.png" alt="a&quot; onerror=&quot;alert(1)">');
    expect(out).toBe('<img src="https://x.dev/i.png" alt="a&quot; onerror=&quot;alert(1)">');
    expect(out).not.toContain('" onerror="');
  });
});

describe('sanitizeHtml: malformed input', () => {
  it('leaves a bare < or > as text', () => {
    expect(sanitizeHtml('a < b > c')).toBe('a &lt; b &gt; c');
    expect(sanitizeHtml('an <unfinished tag')).toBe('an &lt;unfinished tag');
  });

  it('does not read an autolink as a tag', () => {
    expect(sanitizeHtml('<https://x.dev>')).toBe('&lt;https://x.dev&gt;');
  });

  it('keeps a `>` that sits inside a quoted attribute value', () => {
    expect(sanitizeHtml('<p title="a > b">x</p>')).toBe('<p title="a &gt; b">x</p>');
  });

  it('drops a closing tag for a void element', () => {
    expect(sanitizeHtml('a<br></br>b')).toBe('a<br>b');
  });

  it('returns an empty string for an empty input', () => {
    expect(sanitizeHtml('')).toBe('');
  });
});

describe('sanitizeHtml: a word that is not an element', () => {
  /**
   * `<database>` is not HTML — it is a word someone typed in a sentence. Dropped
   * as an unknown tag, the sentence loses it silently, and the reader cannot tell
   * anything was ever there. So a name HTML does not have is escaped and shown.
   */
  it('escapes it instead of dropping it', () => {
    expect(sanitizeHtml('/<database>/-/create')).toBe('/&lt;database&gt;/-/create');
    expect(sanitizeHtml('use <table_name> here')).toBe('use &lt;table_name&gt; here');
  });

  it('still drops a REAL element that is not allowed, keeping its words', () => {
    // The distinction: `font` and `center` are elements, so the wrapper goes and
    // the text stays. That is what an Atom-feed body needs.
    expect(sanitizeHtml('a <font size="7">big</font> word')).toBe('a big word');
    expect(sanitizeHtml('<center>middle</center>')).toBe('middle');
  });

  it('treats a hyphenated name as a custom element, not as a word', () => {
    expect(sanitizeHtml('<my-widget>x</my-widget>')).toBe('x');
  });
});
