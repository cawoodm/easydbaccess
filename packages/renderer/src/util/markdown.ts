// packages/renderer/src/util/markdown.ts
//
// A small Markdown → HTML converter, written here rather than pulled in as a
// dependency: the whole renderer bundle is ~600 kB and `marked` alone would add
// a third of that for what column scripts actually use — emphasis, code, links,
// lists, headings, tables.
//
// SAFETY: the source is escaped FIRST, so raw HTML in the Markdown is shown as
// text rather than injected. That is the opposite of CommonMark, which passes
// HTML through, and it is deliberate. Markdown reaches this function from cell
// DATA — a column script runs `markdownToHtml(row.notes)` over whatever was
// imported — and imported data is not authored by the person looking at it. A
// `<script>` or an `onerror=` in a CSV column must not become live markup in
// the grid. Script AUTHORS are trusted (they can already do anything on the
// page); the rows they read are not.
//
// The supported subset, and nothing else:
//   # h1 … ###### h6        **bold**  __bold__      *em*  _em_
//   ~~strike~~              `code`    ```fenced```  (``` or ~~~, optional lang)
//   [text](url)             ![alt](url)             <https://autolink>
//   - / * / + bullets       1. ordered              nested by 2-space indent
//   > blockquote            --- hr                  | tables | with alignment
//   paragraphs, and a hard break from two trailing spaces
//
// Anything else passes through as escaped text. Unit tests in markdown.test.ts.

/**
 * Placeholder wrapper for an extracted code span. A private-use code point, so
 * it cannot collide with anything a person would type — and any that do arrive
 * in the source are stripped before extraction, so the input can never forge a
 * placeholder and pull out a span that was not its own.
 */
const SENTINEL = '\uE000';
const SENTINEL_RE = /\uE000(\d+)\uE000/g;

/** HTML-escape text so it can never become markup. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A URL safe to put in `href`/`src`. Rejects everything but http, https,
 * mailto, tel and relative paths — `javascript:` and `data:` in a link are the
 * classic way markdown turns into script execution.
 */
function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === '') return null;
  // A scheme-relative or absolute path, or anything with no scheme at all, is
  // fine — there is nothing executable about it.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  return /^(https?|mailto|tel):/i.test(url) ? url : null;
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

  s = esc(s);

  // Images before links — `![a](b)` shares the link shape.
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, alt: string, url: string, title?: string) => {
    const href = safeUrl(url);
    return href === null ? m : `<img src="${href}" alt="${alt}"${title ? ` title="${title}"` : ''}>`;
  });
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, text: string, url: string, title?: string) => {
    const href = safeUrl(url);
    // External links open in a new tab, and `noopener` denies the opened page
    // a handle back to this one.
    return href === null ? m : `<a href="${href}"${title ? ` title="${title}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Autolink: <https://…>, already escaped to &lt;…&gt;.
  s = s.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (m, url: string) => {
    const href = safeUrl(url);
    return href === null ? m : `<a href="${href}" target="_blank" rel="noopener noreferrer">${href}</a>`;
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
    const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1]!.slice(0, 3);
      i++;
      const body = take((l) => !l.trim().startsWith(close));
      if (i < lines.length) i++; // the closing fence
      const lang = fence[2] ? ` class="language-${fence[2]}"` : '';
      out.push(`<pre><code${lang}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!.replace(/\s+#+\s*$/, ''))}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      const block = take((l) => /^\s*>/.test(l) || l.trim() !== '');
      // Recurse on the un-quoted body so a blockquote can hold anything.
      out.push(`<blockquote>${markdownToHtml(block.map((l) => l.replace(/^\s*>\s?/, '')).join('\n'))}</blockquote>`);
      continue;
    }

    // Table: a header row followed by a |---|:--:| delimiter row.
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
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

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
      const block = take((l) => l.trim() !== '' && !/^\s*(?:```|~~~|#{1,6}\s)/.test(l));
      out.push(list(block));
      continue;
    }

    // Paragraph: everything up to a blank line or the start of another block.
    const para = take((l) => l.trim() !== '' && !/^\s*(?:```|~~~|>|#{1,6}\s|(?:[-*+]|\d+[.)])\s)/.test(l) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l));
    if (para.length > 0) out.push(`<p>${inline(para.join('\n'))}</p>`);
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
