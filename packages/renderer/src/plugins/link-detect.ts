// packages/renderer/src/plugins/link-detect.ts
//
// Is this cell value a link, and what should the anchor point at?
//
// Pure, so the rules — which are mostly about what NOT to link — are testable
// without a DOM. Used by `cell-link.ts` to render one and by `auto-renderer.ts`
// to guess that a whole column is made of them, so the two cannot disagree about
// what a URL is.
//
// The renderer accepted `http://` and `https://` and nothing else until v0.0.438.
// Any scheme works now, `file:///` included, which is what a table of local
// documents needs.

/**
 * Schemes that RUN something when followed. Never linkable, whatever the value
 * says.
 *
 * This is the reason "any scheme" needs a rule at all. Cell values arrive from
 * an import, a sync pull or a workspace someone sent, so a `javascript:` value
 * in a table is a script somebody else wrote waiting for a click. `data:` is the
 * same trick with a payload attached.
 */
const DANGEROUS = new Set(['javascript', 'vbscript', 'data']);

/**
 * Schemes that are real links without a `//` authority.
 *
 * Everything else must be written `scheme://…` to count, because a bare
 * `word:something` is far more often prose — `TODO:fix this`, `Note:call back` —
 * than a URI, and turning that into a link is worse than missing an exotic one.
 */
const NO_AUTHORITY = new Set(['mailto', 'tel', 'sms', 'callto', 'geo', 'urn', 'magnet', 'bitcoin']);

/** RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
const SCHEME = /^([a-z][a-z0-9+.-]*):(\/\/)?/i;

export interface DetectedLink {
  /** What the anchor's `href` gets — the value, with spaces encoded for `file:`. */
  href: string;
  /** What the cell shows: the value exactly as it is stored. */
  label: string;
  /** Lower-cased scheme, without the colon. */
  scheme: string;
  /** True for a `scheme://…` URL — the only kind worth a new tab. */
  newTab: boolean;
}

/**
 * The link a value is, or null.
 *
 * Two rules beyond the scheme itself:
 *
 *  - **The whole cell has to be the link.** Whitespace disqualifies a value, as
 *    it always has: a sentence that happens to contain a URL is prose, and the
 *    grid has no way to show half a cell as a link.
 *  - **`file:` is the exception**, because a local path routinely contains
 *    spaces (`file:///C:/My Documents/report.pdf`). The space is encoded in the
 *    `href` and left alone in the label, so the cell reads as the user typed it
 *    and the link still resolves.
 */
export function detectLink(s: string): DetectedLink | null {
  const t = s.trim();
  if (!t) return null;
  const m = SCHEME.exec(t);
  if (!m) return null;
  const scheme = (m[1] ?? '').toLowerCase();
  const authority = m[2] === '//';
  if (DANGEROUS.has(scheme)) return null;
  if (!authority && !NO_AUTHORITY.has(scheme)) return null;
  // Nothing after the scheme is not a link — `http://` on its own goes nowhere.
  if (t.length === m[0].length) return null;
  const spaced = /\s/.test(t);
  if (spaced && scheme !== 'file') return null;
  return {
    href: spaced ? t.replace(/ /g, '%20') : t,
    label: t,
    scheme,
    newTab: authority,
  };
}

/** Would this value render as a link? What `auto-renderer` asks per sample. */
export function isLinkValue(s: string): boolean {
  return detectLink(s) !== null;
}

/**
 * A browser tab refuses to navigate from `http(s)` to `file:`, silently — the
 * click does nothing and only the console says why. The packaged desktop app
 * loads the renderer from `file:` itself, so there the link opens.
 *
 * So the tooltip says which case the reader is in, rather than letting them find
 * out by clicking into silence. Takes the page's own protocol, which is the whole
 * question.
 */
export function linkTitle(link: DetectedLink, pageProtocol: string): string {
  if (link.scheme === 'file' && pageProtocol !== 'file:') {
    return `${link.label} — a browser tab cannot open a local file. The desktop app can, or copy the link.`;
  }
  if (link.scheme === 'mailto') return `Email ${link.label}`;
  if (link.scheme === 'tel' || link.scheme === 'callto') return `Call ${link.label}`;
  return `Open ${link.label}`;
}
