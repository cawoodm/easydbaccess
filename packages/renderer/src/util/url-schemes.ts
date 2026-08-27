// packages/renderer/src/util/url-schemes.ts
//
// Which URL schemes are safe to put behind a click, in ONE place.
//
// Two things needed the same answer and gave different ones. `plugins/link-detect.ts`
// (the Link cell renderer, since v0.0.438) allows any scheme except the ones that
// RUN something, so a table of `file:///` paths works. `util/sanitize-html.ts`'s
// `safeUrl` kept an ALLOW-list of http/https/mailto/tel, so the same `file:///`
// in a markdown cell or a hand-written view template came out as plain text.
//
// A deny-list is the right shape for this. The dangerous schemes are a short,
// closed set that has not grown in twenty years, while the useful ones are
// open-ended and mostly platform-specific — `file`, `ftp`, `obsidian`, `slack`,
// `ms-excel`, `zoommtg`. An allow-list of those is a list nobody can finish, and
// every omission reads to the user as a bug.

/**
 * Schemes that execute rather than navigate. Never linkable, whatever the value
 * says.
 *
 * This is the reason "any scheme" needs a rule at all. Values arrive from an
 * import, a sync pull or a workspace someone sent, so a `javascript:` value is a
 * script somebody else wrote waiting for a click. `data:` is the same trick with
 * a payload attached, and `vbscript:` is the old-IE spelling that still parses in
 * some embedders.
 */
export const DANGEROUS_SCHEMES: ReadonlySet<string> = new Set(['javascript', 'vbscript', 'data']);

/**
 * Schemes that are real links without a `//` authority.
 *
 * Everything else must be written `scheme://…` to count, because a bare
 * `word:something` is far more often prose — `TODO:fix this`, `Note:call back` —
 * than a URI, and turning that into a link is worse than missing an exotic one.
 */
export const NO_AUTHORITY_SCHEMES: ReadonlySet<string> = new Set(['mailto', 'tel', 'sms', 'callto', 'geo', 'urn', 'magnet', 'bitcoin']);

/** RFC 3986: scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ). */
export const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * The scheme of `url`, lower-cased, or null when it carries none — a relative
 * path, a `#fragment`, a scheme-relative `//host/…`.
 */
export function schemeOf(url: string): string | null {
  const m = SCHEME_RE.exec(url.trim());
  return m ? (m[1] ?? '').toLowerCase() : null;
}

/** Does following this URL run code rather than go somewhere? */
export function runsScript(url: string): boolean {
  const scheme = schemeOf(url);
  return scheme !== null && DANGEROUS_SCHEMES.has(scheme);
}

/**
 * Is this token worth turning into a link on its own, with nothing but its own
 * shape to go on?
 *
 * Stricter than {@link runsScript}, and deliberately so. `safeUrl` answers "may
 * this URL be a target", which is a question about safety; this answers "did the
 * author mean a link here", which is a question about intent — and getting it
 * wrong turns `Note:remind me` into a dead anchor in the middle of a sentence.
 */
export function isBareLink(token: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):(\/\/)?(.*)$/i.exec(token.trim());
  if (!m) return false;
  const scheme = (m[1] ?? '').toLowerCase();
  if (DANGEROUS_SCHEMES.has(scheme)) return false;
  if (m[2] !== '//' && !NO_AUTHORITY_SCHEMES.has(scheme)) return false;
  // Nothing after the scheme is not a link — `http://` on its own goes nowhere.
  return (m[3] ?? '') !== '';
}
