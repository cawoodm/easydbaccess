// packages/renderer/src/util/markdown.ts
//
// A small Markdown → HTML converter, written here rather than pulled in as a
// dependency: the whole renderer bundle is ~600 kB and `marked` alone would add
// a third of that for what column scripts actually use — emphasis, code, links,
// lists, headings, tables.
//
// SAFETY: raw HTML in the source is SANITIZED, not escaped — see
// `sanitize-html.ts`. Markdown reaches this function from cell DATA, and cell
// data is not authored by the person looking at it, but it does contain real
// markup they want to see: an Atom-feed body is `<p><strong><a href=…>` and
// escaping it showed the tags as text, which made `markdownToHtml(row.body)`
// useless on such a column. So the tags are rebuilt from an allowlist instead:
// formatting survives, and a `<script>` or an `onerror=` from a CSV cannot.
// This is CommonMark's HTML behaviour minus what can execute.
//
// A `<word>` that is no HTML element at all is the exception: it is escaped and
// shown. `/<database>/-/create` in a release note is prose, and dropping it as an
// unknown tag left a hole in the sentence.
//
// The supported subset, and nothing else:
//   # h1 … ###### h6        **bold**  __bold__      *em*  _em_
//   ~~strike~~              `code`    ```fenced```  (``` or ~~~, optional lang)
//   [text](url)             ![alt](url)             <https://autolink>
//   - / * / + bullets       1. ordered              nested by 2-space indent
//   > blockquote            --- hr                  | tables | with alignment
//   paragraphs, and a hard break from two trailing spaces
//   sanitized inline HTML, and raw HTML blocks (CommonMark rule 6)
//
// Anything else passes through as escaped text. Unit tests in markdown.test.ts.

import { esc, escEntityAware, safeUrl, sanitizeHtml, sanitizeTagOrText, stripUnsafe, TAG_RE } from './sanitize-html.js';
import { looksLikeHtml } from './html-text.js';

/**
 * Placeholder wrapper for an extracted code span. A private-use code point, so
 * it cannot collide with anything a person would type — and any that do arrive
 * in the source are stripped before extraction, so the input can never forge a
 * placeholder and pull out a span that was not its own.
 */
const SENTINEL = '\uE000';
const SENTINEL_RE = /\uE000(\d+)\uE000/g;

/**
 * A link OUT of the app opens a new tab \u2014 navigating this one would throw the
 * whole workspace away \u2014 and `noopener` denies the opened page a handle back.
 *
 * A `#fragment` addresses THIS document, so it never navigates away and gets
 * neither: a new tab would reload the workspace to go nowhere, and it stopped
 * same-page links (a commandlet, a `[Genesis 2](#Genesis%202)`) from working at
 * all. `sanitize-html.ts` makes the same distinction for hand-written HTML.
 */
function newTabAttrs(href: string): string {
  return href.startsWith('#') ? '' : ' target="_blank" rel="noopener noreferrer"';
}

/**
 * The block openers, one definition each, used BOTH by the branch that consumes
 * the block and by the paragraph fallthrough that must stop in front of it.
 *
 * They have to come from the same place. A paragraph stops on any line these
 * match; if one of them matched a line that no branch then claimed, the run
 * would consume nothing, `i` would not move, and the block loop would spin
 * forever — freezing the tab, not throwing. That is exactly what an indented
 * `#` did: the heading branch is anchored at `^#` (an indented `#` is code, not
 * a heading) while the paragraph rule stopped on `^\s*#`, so `    # comment`
 * inside a 4-space code block belonged to nobody.
 */
const FENCE_RE = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s*>/;
const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
/** A table's `|---|:--:|` delimiter row, which only means anything as line two. */
const DELIM_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

/**
 * Tag names that open a raw-HTML BLOCK: the run of lines up to the next blank
 * line is HTML, and no Markdown rule applies inside it. This is CommonMark's
 * rule 6, and it is what stops `<p>x</p>` in the data from being wrapped in a
 * paragraph of our own — `<p><p>x</p></p>` is what that produced.
 *
 * Span-level tags are absent on purpose. A line starting with `<span>` is an
 * ordinary paragraph, and its tags are handled inline.
 */
const HTML_BLOCK_TAGS =
  'address|article|aside|blockquote|caption|col|colgroup|dd|details|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|iframe|legend|li|main|nav|ol|p|pre|script|section|style|summary|table|tbody|td|tfoot|th|thead|tr|ul';
const HTML_BLOCK_RE = new RegExp(`^\\s*</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`, 'i');

/** Does `line` open a block, i.e. must a paragraph stop in front of it? */
function opensBlock(line: string): boolean {
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || HTML_BLOCK_RE.test(line);
}

/** Inline spans: code first (its contents are literal), then the rest. */
function inline(src: string): string {
  // `code` wins over every other marker, so it is extracted before anything
  // else runs and restored at the end — otherwise `*` inside a code span
  // would be read as emphasis.
  const spans: string[] = [];
  let s = src.replaceAll(SENTINEL, '').replace(/(`+)([\s\S]*?)\1/g, (_m, _t, code: string) => {
    spans.push(`<code>${esc(code)}</code>`);
    return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
  });

  // Inline HTML from the data goes into the SAME placeholder list as code
  // spans, so a sanitized tag is opaque to every rule below it: no emphasis
  // marker inside an `href` can be read as emphasis, and no rule can graft a
  // `<em>` into the middle of an attribute value.
  s = stripUnsafe(s).replace(TAG_RE, (m: string, closing: string, name: string, attrs: string) => {
    const tag = sanitizeTagOrText(m, closing === '/', name, attrs);
    if (tag === '') return '';
    spans.push(tag);
    return `${SENTINEL}${spans.length - 1}${SENTINEL}`;
  });

  s = escEntityAware(s);

  // Images before links — `![a](b)` shares the link shape.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt: string, url: string, title?: string) => {
    const href = safeUrl(url);
    return href === null ? m : `<img src="${href}" alt="${alt}"${title ? ` title="${title}"` : ''}>`;
  });
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, text: string, url: string, title?: string) => {
    const href = safeUrl(url);
    return href === null ? m : `<a href="${href}"${title ? ` title="${title}"` : ''}${newTabAttrs(href)}>${text}</a>`;
  });
  // Autolink: <https://…>, already escaped to &lt;…&gt;.
  s = s.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (m, url: string) => {
    const href = safeUrl(url);
    return href === null ? m : `<a href="${href}"${newTabAttrs(href)}>${href}</a>`;
  });

  s = s.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');
  // Bold before italic, so `***x***` nests rather than mis-pairing.
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([\s\S]+?)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*(?!\s)([^*]+?)\*/g, '$1<em>$2</em>');
  // `_` only at a word boundary, so snake_case_names survive intact.
  s = s.replace(/(^|[\s(])_(?!\s)([^_]+?)_(?=$|[\s).,;:!?])/g, '$1<em>$2</em>');

  // Two trailing spaces = hard break (the escape ran already, so look at \n).
  s = s.replace(/ {2,}\n/g, '<br>\n');

  return s.replace(SENTINEL_RE, (_m, i: string) => spans[Number(i)] ?? '');
}

/** One table row's cells, honouring escaped pipes. */
function cells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

const ALIGN = (spec: string): string => {
  const l = spec.startsWith(':');
  const r = spec.endsWith(':');
  if (l && r) return ' style="text-align:center"';
  if (r) return ' style="text-align:right"';
  if (l) return ' style="text-align:left"';
  return '';
};

/**
 * Line markers that mean the value IS Markdown. Stricter than the block openers
 * the converter runs on: each needs real content after the marker, so a lone `#`
 * or a `>` in ">>> ERROR" does not qualify. The converter can afford to be loose
 * — it has already been told the value is Markdown — while detection cannot.
 */
const MD_BLOCK: readonly RegExp[] = [
  /^ {0,3}#{1,6}\s+\S/, // heading
  /^ {0,3}>[ \t]+\S/, // blockquote
  /^ {0,3}[-*+][ \t]+\S/, // bullet list
  /^ {0,3}\d+[.)][ \t]+\S/, // ordered list
  /^ {0,3}(?:```|~~~)/, // fenced code
  HR_RE, // thematic break
];

/**
 * Inline markers that mean the value IS Markdown. Deliberately narrower than
 * what the converter accepts: `*em*` and `__bold__` are left out, because
 * `SELECT a*b*c` and `__init__` are ordinary text that would otherwise be read
 * as Markdown.
 */
const MD_INLINE: readonly RegExp[] = [
  /\*\*(?!\s)[^*\n]+\*\*/, // **bold**
  /~~(?!\s)[^~\n]+~~/, // ~~strike~~
  /`[^`\n]+`/, // `code`
  /!?\[[^\]\n]*\]\([^)\s]+\)/, // [text](url) and ![alt](url)
];

/**
 * True when `src` plausibly IS Markdown. Used by the `preview` renderer, which
 * converts a cell before showing it — so a column of Markdown reads as
 * formatted text without anyone writing a script for it.
 *
 * A false positive turns ordinary prose into markup, so a value counts as
 * Markdown only on a marker with no plain-text reading: a heading, a list, a
 * blockquote, a fence, a rule, a table delimiter, `**bold**`, `~~strike~~`,
 * `` `code` `` or a `[link](url)`. Everything else is text. HTML is not tested
 * for here — a caller that has both decides which one wins.
 */
/**
 * Which markup language a value is written in, if either — the decision a cell
 * renderer has to make before it shows a value.
 *
 * MARKDOWN IS TESTED FIRST, and that order is the point. `looksLikeHtml` reads
 * any `<word>` as a tag, and Markdown prose is full of angle-bracket words that
 * are not tags at all: a Datasette changelog says `/<database>/-/create` in
 * every second line. Treated as HTML, those "tags" are swallowed and the text
 * loses them (plus every `**bold**` and `[link](url)` stays literal). Converted
 * as Markdown, they come back as `&lt;database&gt;` and the formatting works.
 *
 * A value that OPENS with a tag is HTML whatever else it holds — that is a
 * document or a fragment, not prose that happens to mention a tag.
 */
export function markupKind(value: unknown): 'html' | 'markdown' | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (!OPENS_WITH_TAG.test(value) && looksLikeMarkdown(value)) return 'markdown';
  if (looksLikeHtml(value)) return 'html';
  return looksLikeMarkdown(value) ? 'markdown' : null;
}

/** A value whose FIRST non-space character starts a real tag. */
const OPENS_WITH_TAG = /^\s*<\/?[a-z][a-z0-9]*(\s|\/?>)/i;

export function looksLikeMarkdown(src: unknown): boolean {
  if (typeof src !== 'string' || src.trim() === '') return false;
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  if (lines.some((l) => MD_BLOCK.some((re) => re.test(l)))) return true;
  if (MD_INLINE.some((re) => re.test(src))) return true;
  // A delimiter row is only a table with a header row above it.
  return lines.some((l, i) => i > 0 && DELIM_RE.test(l) && l.includes('-') && (lines[i - 1] ?? '').includes('|'));
}

/**
 * Convert Markdown to an HTML string.
 *
 * Call it from a column script:
 * ```js
 * function render(row) {
 *   return markdownToHtml(row.notes);
 * }
 * ```
 * …and set that column's renderer to `html` so the result is shown as markup
 * rather than as its own source text.
 *
 * Never throws and never returns `undefined`: a null/blank input yields `''`,
 * because a cell renderer has nowhere useful to put an exception.
 */
export function markdownToHtml(src: unknown): string {
  if (src == null) return '';
  const text = typeof src === 'string' ? src : String(src);
  if (text.trim() === '') return '';

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  /** Collect a run of lines while `keep` holds, returning them. */
  const take = (keep: (line: string) => boolean): string[] => {
    const block: string[] = [];
    while (i < lines.length && keep(lines[i]!)) block.push(lines[i++]!);
    return block;
  };

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code — contents are literal, so no inline pass.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const close = fence[1]!.slice(0, 3);
      i++;
      const body = take((l) => !l.trim().startsWith(close));
      if (i < lines.length) i++; // the closing fence
      const lang = fence[2] ? ` class="language-${fence[2]}"` : '';
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    // A raw HTML block: everything up to the next blank line is markup, kept
    // as markup (sanitized) and never wrapped in a paragraph. A feed body is
    // mostly this. The run always contains the current line, so the block loop
    // cannot stall here.
    if (HTML_BLOCK_RE.test(line)) {
      const block = take((l) => l.trim() !== '');
      const html = sanitizeHtml(block.join('\n'));
      if (html.trim() !== '') out.push(html);
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!.replace(/\s+#+\s*$/, ''))}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const block = take((l) => QUOTE_RE.test(l) || l.trim() !== '');
      // Recurse on the un-quoted body so a blockquote can hold anything.
      out.push(`<blockquote>${markdownToHtml(block.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'))}</blockquote>`);
      continue;
    }

    // Table: a header row followed by a |---|:--:| delimiter row.
    if (line.includes('|') && i + 1 < lines.length && DELIM_RE.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = cells(line);
      const aligns = cells(lines[i + 1]!).map(ALIGN);
      i += 2;
      const body = take((l) => l.trim() !== '' && l.includes('|'));
      const th = head.map((c, n) => `<th${aligns[n] ?? ''}>${inline(c)}</th>`).join('');
      const rows = body.map(
        (r) =>
          `<tr>${cells(r)
            .map((c, n) => `<td${aligns[n] ?? ''}>${inline(c)}</td>`)
            .join('')}</tr>`,
      );
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${rows.join('')}</tbody></table>`);
      continue;
    }

    if (LIST_RE.test(line)) {
      const block = take((l) => l.trim() !== '' && !FENCE_RE.test(l) && !HEADING_RE.test(l));
      out.push(list(block));
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const para = take((l) => l.trim() !== '' && !opensBlock(l));
    // `opensBlock` mirrors the branches above, so the current line never opens a
    // block here and the run is never empty. Kept as a backstop regardless: a
    // future branch that stops a paragraph without consuming its own line would
    // hang the tab, and one line of escaped output is a better failure mode.
    if (para.length === 0) {
      out.push(`<p>${inline(line)}</p>`);
      i++;
      continue;
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }

  return out.join('\n');
}

/**
 * A run of list lines → nested `<ul>`/`<ol>`. Nesting is by leading indent (any
 * deeper indent opens a sub-list), and a line that is not a bullet continues
 * the item above it — the "lazy continuation" Markdown authors expect.
 */
function list(block: string[]): string {
  interface Item {
    text: string[];
    children: string[];
    indent: number;
  }
  const items: Item[] = [];
  let ordered: boolean | null = null;
  let baseIndent: number | null = null;

  for (const line of block) {
    const m = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!m) {
      // Continuation of the current item.
      items[items.length - 1]?.text.push(line.trim());
      continue;
    }
    const indent = m[1]!.length;
    baseIndent ??= indent;
    if (indent > baseIndent && items.length > 0) {
      items[items.length - 1]!.children.push(line.slice(Math.min(indent, baseIndent + 2)));
      continue;
    }
    ordered ??= m[3] !== undefined;
    items.push({ text: [m[4]!], children: [], indent });
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items
    .map((it) => {
      const inner = inline(it.text.join('\n'));
      return `<li>${inner}${it.children.length > 0 ? list(it.children) : ''}</li>`;
    })
    .join('');
  return `<${tag}>${body}</${tag}>`;
}
