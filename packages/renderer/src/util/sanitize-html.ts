// packages/renderer/src/util/sanitize-html.ts
//
// An allowlist sanitizer for HTML that arrives as cell DATA.
//
// Cell values are imported — from a CSV, a Datasette instance, an Atom feed —
// so nobody in the room authored them. They still contain real markup that the
// user wants to SEE: a feed body is `<p><strong><a href=…>` and reading it as
// escaped source text is useless. Escaping everything was the old answer here
// and it made `markdownToHtml(row.body)` unusable on such a column.
//
// The sanitizer never copies markup through. It reads each tag, then REBUILDS
// it from an allowlist of tag names and, per tag, an allowlist of attributes.
// Anything it does not recognise is dropped. Building the output rather than
// filtering the input is what makes the result safe: an attribute or a scheme
// nobody thought about cannot survive, because nothing survives that this file
// does not write out itself.
//
// What is deliberately NOT allowed:
//   - `class` and `style`. The feed bodies are full of `<span class="pl-k">`
//     from a syntax highlighter this app has no CSS for, and a data-supplied
//     class name can collide with the app's own chrome classes and break the
//     layout of the window it renders in.
//   - Every `on*` handler, `script`, `style`, `iframe`, `object`, `embed`,
//     `svg` and `math` — those four elements can carry script of their own.
//   - Any URL scheme but http, https, mailto, tel and a relative path.

/** HTML-escape text so it can never become markup. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Escape a value that came from HTML, where `&amp;` and `&#8217;` are already
 * entities. A blanket `&` → `&amp;` would double-encode them and show the
 * source of the entity instead of the character, so only a NAKED `&` — one
 * that does not open an entity — is escaped.
 */
export function escEntityAware(s: string): string {
  return s
    .replace(/&(?![a-zA-Z][a-zA-Z0-9]*;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Decode the entities that matter when a value has to be inspected as text. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/gi, '&');
}

/**
 * A URL safe to put in `href`/`src`. Rejects everything but http, https,
 * mailto, tel and relative paths — `javascript:` and `data:` in a link are the
 * classic way markup turns into script execution.
 */
export function safeUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === '') return null;
  // A scheme-relative or absolute path, or anything with no scheme at all, is
  // fine — there is nothing executable about it.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url;
  return /^(https?|mailto|tel):/i.test(url) ? url : null;
}

/**
 * The URL for a sanitized attribute, or `null` to drop the attribute.
 *
 * The browser decodes entities and ignores control characters AFTER we hand the
 * attribute over, so the scheme test has to see what the browser will see:
 * `javascript&#58;alert(1)` and a `javascript:` with an embedded tab are both
 * live script URLs, and neither one looks like a scheme to `safeUrl` on its own.
 * The test therefore runs on a probe reduced to printable ASCII, while the
 * emitted value keeps whatever the source had.
 */
function urlAttr(raw: string): string | null {
  const decoded = decodeEntities(raw).trim();
  const probe = decoded.replace(/[^!-~]/g, '');
  return safeUrl(probe) === null ? null : decoded;
}

/**
 * Elements dropped together with everything inside them. `base`, `link` and
 * `meta` are absent on purpose: they are void, so they open no run of content,
 * and not being in `ALLOWED` is already enough to drop them.
 */
const UNSAFE = 'script|style|iframe|object|embed|noscript|template|svg|math|frame|frameset';
const UNSAFE_PAIR_RE = new RegExp(`<(${UNSAFE})\\b(?:"[^"]*"|'[^']*'|[^"'>])*>[\\s\\S]*?<\\/\\s*\\1\\s*>`, 'gi');
/**
 * An unclosed one takes the rest of the string with it - the safe direction for
 * input this mangled. Only an OPENING tag does that: a lone `</script>` closes
 * nothing, so it is left for `sanitizeTag` to drop.
 */
const UNSAFE_OPEN_RE = new RegExp(`<(?:${UNSAFE})\\b[\\s\\S]*$`, 'i');

/** Tags that carry no closing tag, so a stray `</br>` is dropped. */
const VOID = new Set(['br', 'hr', 'img', 'source', 'wbr', 'col']);

/** Every tag name the sanitizer will emit. */
const ALLOWED = new Set([
  'a',
  'abbr',
  'audio',
  'b',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  's',
  'samp',
  'small',
  'source',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
]);

/** Attributes allowed on any element. */
const GLOBAL_ATTRS = new Set(['title', 'dir', 'lang']);

/** Attributes allowed per element, on top of `GLOBAL_ATTRS`. */
const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href']),
  audio: new Set(['src', 'controls']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  img: new Set(['src', 'alt', 'width', 'height']),
  ol: new Set(['start', 'reversed']),
  source: new Set(['src', 'type']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  th: new Set(['colspan', 'rowspan', 'scope', 'headers']),
  time: new Set(['datetime']),
  video: new Set(['src', 'controls', 'poster', 'width', 'height']),
};

/** Attributes whose value is a URL and must pass `urlAttr`. */
const URL_ATTRS = new Set(['href', 'src', 'poster']);

/**
 * One tag's attributes. Values may be double-quoted, single-quoted, unquoted,
 * or absent (a boolean attribute such as `controls`).
 */
const ATTR_RE = /([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;

/**
 * Matches one tag. Two details carry weight:
 *
 * - The attribute part steps over quoted values, so a `>` inside
 *   `title="a > b"` does not end the tag early.
 * - Attributes, when present, must start with whitespace. Without that, the
 *   autolink `<https://x.dev>` parses as a tag named `https` with the attributes
 *   `://x.dev`, and the sanitizer drops the whole link.
 * - No whitespace is allowed between `<` and the name, which is what browsers
 *   do: `a < b > c` is text, not an element named `b`.
 * - The name may contain `-`, so a custom element is recognised and DROPPED
 *   rather than shown as its own source text.
 */
export const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s(?:"[^"]*"|'[^']*'|[^"'>])*)?)\s*\/?>/g;

/**
 * Rebuild one tag from the allowlist, or return `''` to drop it. Dropping the
 * tag keeps the text between it and its partner — a `<span class=…>` wrapper
 * disappears and its words stay.
 */
export function sanitizeTag(closing: boolean, rawName: string, rawAttrs: string): string {
  const tag = rawName.toLowerCase();
  if (!ALLOWED.has(tag)) return '';
  if (closing) return VOID.has(tag) ? '' : `</${tag}>`;

  const allowed = TAG_ATTRS[tag];
  let out = `<${tag}`;
  let hasHref = false;
  let hasSrc = false;
  for (const m of rawAttrs.matchAll(ATTR_RE)) {
    const name = m[1]!.toLowerCase();
    if (!GLOBAL_ATTRS.has(name) && !allowed?.has(name)) continue;
    const raw = m[2] ?? m[3] ?? m[4];
    if (raw === undefined) {
      out += ` ${name}`;
      continue;
    }
    if (URL_ATTRS.has(name)) {
      const url = urlAttr(raw);
      if (url === null) continue;
      if (name === 'href') hasHref = true;
      if (name === 'src') hasSrc = true;
      out += ` ${name}="${escEntityAware(url)}"`;
      continue;
    }
    out += ` ${name}="${escEntityAware(raw)}"`;
  }
  // The grid is a single-page app. A link that navigates the current tab would
  // throw the whole workspace away, so every link opens a new tab, and
  // `noopener` denies the opened page a handle back to this one.
  if (tag === 'a' && hasHref) out += ' target="_blank" rel="noopener noreferrer"';
  // An image with no usable source shows a broken-image glyph and nothing else.
  if ((tag === 'img' || tag === 'source') && !hasSrc) return '';
  return `${out}>`;
}

/** Drop comments, declarations, and the elements that can carry script. */
export function stripUnsafe(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(UNSAFE_PAIR_RE, '')
    .replace(UNSAFE_OPEN_RE, '')
    .replace(/<[!?][^>]*>/g, '');
}

/**
 * Sanitize a run of HTML: allowed tags are rebuilt, everything else becomes
 * text. Text keeps its entities (see `escEntityAware`), so `&amp;` in the
 * source still shows as `&`.
 */
export function sanitizeHtml(src: string): string {
  const cleaned = stripUnsafe(src);
  let out = '';
  let at = 0;
  for (const m of cleaned.matchAll(TAG_RE)) {
    out += escEntityAware(cleaned.slice(at, m.index));
    out += sanitizeTag(m[1] === '/', m[2]!, m[3]!);
    at = m.index + m[0].length;
  }
  return out + escEntityAware(cleaned.slice(at));
}
