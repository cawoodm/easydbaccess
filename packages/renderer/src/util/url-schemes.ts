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
// A deny-list is the right DEFAULT for this. The dangerous schemes are a short,
// closed set that has not grown in twenty years, while the useful ones are
// open-ended and mostly platform-specific — `file`, `ftp`, `obsidian`, `slack`,
// `ms-excel`, `zoommtg`. An allow-list of those is a list nobody can finish, and
// every omission reads to the user as a bug.
//
// Which is a default, not a law: the shape is a SETTING (`links:protocols`,
// registered by `plugins/settings.ts`, read by `util/link-settings.ts`). A list
// of schemes is an allow-list; the same list behind a leading `!` is a deny-list.
// So an install that wants exactly four protocols writes `http,https,ftp,file`,
// and one that only wants the executable ones gone keeps the default
// `!javascript,vbscript,data`.

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

/**
 * Which schemes may be clicked, as the user wrote it.
 *
 * One flag and one list, because that is the whole of what the setting can say:
 * `deny` true ⇒ the list names what is refused and everything else is fine;
 * false ⇒ the list is exhaustive.
 */
export interface ProtocolPolicy {
  deny: boolean;
  schemes: ReadonlySet<string>;
}

/** What the setting says when nobody has touched it. */
export const DEFAULT_PROTOCOLS = '!javascript,vbscript,data';

export const DEFAULT_POLICY: ProtocolPolicy = { deny: true, schemes: DANGEROUS_SCHEMES };

/**
 * Reads the setting's text into a policy.
 *
 * Lenient on purpose — this is a free-text field, and the reader has no way to
 * ask what was meant. Commas, spaces, semicolons and pipes all separate;
 * `http://`, `HTTP` and `http:` all name `http`; anything that is not a scheme at
 * all is dropped rather than failing the whole line.
 *
 * Two empty cases, answered differently. An empty FIELD means "as shipped", so it
 * gives the default. An empty ALLOW-list — `,` or `://` — would silence every link
 * in the app, which no typo deserves, so it gives the default too. An empty
 * DENY-list (`!` alone) is a real answer, and a deliberate one: refuse nothing.
 */
export function parseProtocolPolicy(text: string | null | undefined): ProtocolPolicy {
  const raw = (text ?? '').trim();
  if (raw === '') return DEFAULT_POLICY;
  const deny = raw.startsWith('!');
  const schemes = new Set(
    (deny ? raw.slice(1) : raw)
      .split(/[\s,;|]+/)
      .map((s) => s.trim().toLowerCase().replace(/:\/*$/, ''))
      .filter((s) => /^[a-z][a-z0-9+.-]*$/.test(s)),
  );
  if (!deny && schemes.size === 0) return DEFAULT_POLICY;
  return { deny, schemes };
}

// The policy in force. Module state, because every reader is a pure function
// called while something is being painted — `safeUrl` runs per markdown link and
// `detectLink` per grid cell, and neither can await a settings read. It is
// resolved once at boot and re-resolved when the setting changes; see
// `util/link-settings.ts`.
let current: ProtocolPolicy = DEFAULT_POLICY;

export function setProtocolPolicy(policy: ProtocolPolicy | null | undefined): void {
  current = policy ?? DEFAULT_POLICY;
}

export function protocolPolicy(): ProtocolPolicy {
  return current;
}

/**
 * May a link with this scheme be clicked? `null` — a relative path, a
 * `#fragment` — is not the policy's business and passes.
 */
export function schemeAllowed(scheme: string | null, policy: ProtocolPolicy = current): boolean {
  if (scheme === null) return true;
  return policy.deny ? !policy.schemes.has(scheme) : policy.schemes.has(scheme);
}

/** {@link schemeAllowed} for a whole URL. */
export function urlAllowed(url: string, policy?: ProtocolPolicy): boolean {
  return schemeAllowed(schemeOf(url), policy);
}

/**
 * Is this token worth turning into a link on its own, with nothing but its own
 * shape to go on?
 *
 * Stricter than {@link schemeAllowed}, and deliberately so. `safeUrl` answers "may
 * this URL be a target", which is a question about safety; this answers "did the
 * author mean a link here", which is a question about intent — and getting it
 * wrong turns `Note:remind me` into a dead anchor in the middle of a sentence.
 */
export function isBareLink(token: string): boolean {
  const m = /^([a-z][a-z0-9+.-]*):(\/\/)?(.*)$/i.exec(token.trim());
  if (!m) return false;
  const scheme = (m[1] ?? '').toLowerCase();
  if (!schemeAllowed(scheme)) return false;
  if (m[2] !== '//' && !NO_AUTHORITY_SCHEMES.has(scheme)) return false;
  // Nothing after the scheme is not a link — `http://` on its own goes nowhere.
  return (m[3] ?? '') !== '';
}
