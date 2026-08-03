import { describe, expect, it } from 'vitest';
import { markdownToHtml } from '../../../packages/renderer/src/util/markdown.js';

describe('markdownToHtml: blocks', () => {
  it('renders headings, paragraphs and a horizontal rule', () => {
    expect(markdownToHtml('# Title')).toBe('<h1>Title</h1>');
    expect(markdownToHtml('###### Six')).toBe('<h6>Six</h6>');
    expect(markdownToHtml('just text')).toBe('<p>just text</p>');
    expect(markdownToHtml('---')).toBe('<hr>');
  });

  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    expect(markdownToHtml('one\ntwo\n\nthree')).toBe('<p>one\ntwo</p>\n<p>three</p>');
  });

  it('renders bullet and ordered lists, including nesting', () => {
    expect(markdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(markdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>');
    expect(markdownToHtml('- a\n  - a1\n- b')).toBe('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
  });

  it('renders a fenced code block literally, keeping the language', () => {
    const html = markdownToHtml('```js\nconst a = 1 < 2;\n```');
    expect(html).toBe('<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>');
  });

  it('renders a blockquote, and blocks inside it', () => {
    expect(markdownToHtml('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(markdownToHtml('> # head')).toBe('<blockquote><h1>head</h1></blockquote>');
  });

  it('renders a table with column alignment', () => {
    const html = markdownToHtml('| a | b |\n| :- | --: |\n| 1 | 2 |');
    expect(html).toContain('<th style="text-align:left">a</th>');
    expect(html).toContain('<th style="text-align:right">b</th>');
    expect(html).toContain('<td style="text-align:right">2</td>');
  });
});

describe('markdownToHtml: inline', () => {
  it('renders emphasis, strong, strike and code', () => {
    expect(markdownToHtml('*a* **b** ~~c~~ `d`')).toBe('<p><em>a</em> <strong>b</strong> <del>c</del> <code>d</code></p>');
    expect(markdownToHtml('__b__ and _i_')).toBe('<p><strong>b</strong> and <em>i</em></p>');
  });

  it('leaves snake_case identifiers alone', () => {
    expect(markdownToHtml('call some_long_name now')).toBe('<p>call some_long_name now</p>');
  });

  it('does not read markers inside a code span', () => {
    expect(markdownToHtml('`a * b * c`')).toBe('<p><code>a * b * c</code></p>');
  });

  it('renders links, images and autolinks', () => {
    expect(markdownToHtml('[t](https://x.dev)')).toBe('<p><a href="https://x.dev" target="_blank" rel="noopener noreferrer">t</a></p>');
    expect(markdownToHtml('![alt](https://x.dev/i.png)')).toBe('<p><img src="https://x.dev/i.png" alt="alt"></p>');
    expect(markdownToHtml('<https://x.dev>')).toContain('<a href="https://x.dev"');
  });

  it('turns two trailing spaces into a hard break', () => {
    expect(markdownToHtml('a  \nb')).toBe('<p>a<br>\nb</p>');
  });
});

describe('markdownToHtml: safety', () => {
  // The input is cell DATA, which nobody in the room authored. These are the
  // assertions that keep an imported CSV from executing in the grid.
  it('escapes raw HTML instead of passing it through', () => {
    expect(markdownToHtml('<script>alert(1)</script>')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(markdownToHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });

  it('refuses a javascript: or data: link, leaving the source as text', () => {
    // The source stays visible as plain text — that is the point. What must
    // not exist is an anchor pointing at it.
    const js = markdownToHtml('[click](javascript:alert(1))');
    expect(js).not.toContain('href');
    expect(js).not.toContain('<a ');
    expect(js).toBe('<p>[click](javascript:alert(1))</p>');
    expect(markdownToHtml('![x](data:text/html;base64,PHN2Zz4=)')).not.toContain('<img');
  });

  it('keeps ordinary relative and mailto links working', () => {
    expect(markdownToHtml('[a](/docs/x.md)')).toContain('href="/docs/x.md"');
    expect(markdownToHtml('[m](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
  });

  it('escapes a quote in link text so it cannot break out of an attribute', () => {
    expect(markdownToHtml('[a" onmouseover="x](https://x.dev)')).not.toContain('onmouseover="x"');
  });
});

describe('markdownToHtml: edge cases', () => {
  it('returns an empty string for nothing at all, rather than throwing', () => {
    expect(markdownToHtml(null)).toBe('');
    expect(markdownToHtml(undefined)).toBe('');
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('   \n  ')).toBe('');
  });

  it('stringifies a non-string value', () => {
    expect(markdownToHtml(42)).toBe('<p>42</p>');
  });

  it('does not hang or throw on an unterminated fence or table', () => {
    expect(() => markdownToHtml('```\nunclosed')).not.toThrow();
    expect(markdownToHtml('```\nunclosed')).toContain('unclosed');
    expect(() => markdownToHtml('| a |\n| - |')).not.toThrow();
  });
});
