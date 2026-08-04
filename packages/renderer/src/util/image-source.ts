// Turning whatever an importer put in a cell into something an <img> can load.
//
// The image renderer used to accept two shapes: a `data:image/...` URI and an
// `http…` URL. A real database column holds neither. Northwind's
// `Employees.Photo` is a JPEG BLOB, so it arrives as a SQL hex literal
// (`X'ffd8ffe0…'`) from a `.sql` dump, and as bytes or bare base64 from a binary
// reader — none of which the renderer recognized, so every employee showed
// "no image".
//
// The media type is read from the bytes, never from a file name or a column
// name: a BLOB carries no name, and the one thing that reliably says "JPEG" is
// `FF D8 FF`.
//
// DOM-free, so the sniffing is unit-tested without a canvas or an <img>.

/** Leading bytes → media type. Longest signature first so none shadows another. */
const MAGIC: Array<{ bytes: number[]; type: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], type: 'image/png' },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: 'image/gif' }, // GIF8
  { bytes: [0xff, 0xd8, 0xff], type: 'image/jpeg' },
  { bytes: [0x42, 0x4d], type: 'image/bmp' }, // BM
];

/** How many leading bytes any check needs. */
const SNIFF_BYTES = 16;

/** `image/webp` is RIFF….WEBP — the tag sits at offset 8, past the file size. */
function isWebp(b: readonly number[]): boolean {
  const ascii = (i: number, s: string) => s.split('').every((c, j) => b[i + j] === c.charCodeAt(0));
  return b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP');
}

/** The media type of these leading bytes, or null when they are not an image. */
export function sniffImageType(bytes: readonly number[]): string | null {
  for (const { bytes: sig, type } of MAGIC) {
    if (sig.every((v, i) => bytes[i] === v)) return type;
  }
  return isWebp(bytes) ? 'image/webp' : null;
}

/**
 * An `<img src>` for `value`, or null when it does not look like an image.
 *
 * Accepted:
 *  - a `data:` URI (kept as-is when it already names an image type, re-typed
 *    from its own bytes when it does not — a BLOB exported as
 *    `data:application/octet-stream;base64,…` is still a JPEG),
 *  - an `http(s)://` or protocol-relative URL, and a root-relative path,
 *  - SQL hex blob text: `X'ffd8…'`, `x"ffd8…"`, or bare hex,
 *  - base64 without the `data:` prefix,
 *  - bytes: a `Uint8Array`, a number array, or the `{0: 255, 1: 216, …}` object
 *    a byte array turns into after a JSON round trip.
 *
 * A URL is trusted on shape alone — its bytes are not there to sniff. Everything
 * else has to prove it is an image, so a plain text cell never renders as a
 * broken thumbnail.
 */
export function imageSrcFrom(value: unknown): string | null {
  if (value == null) return null;

  const bytes = asBytes(value);
  if (bytes) {
    const head = Array.prototype.slice.call(bytes, 0, SNIFF_BYTES) as number[];
    const type = sniffImageType(head);
    return type ? `data:${type};base64,${base64Of(bytes)}` : null;
  }

  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s === '') return null;

  if (s.startsWith('data:')) return retypeDataUri(s);
  if (/^(https?:)?\/\//i.test(s)) return s;
  // A root-relative path, as an exported `.table.json` may carry. One segment of
  // a path is not enough to go on — "notes" is not an image.
  if (s.startsWith('/') && /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(s)) return s;

  const hex = hexBody(s);
  if (hex) {
    const head = hexToBytes(hex.slice(0, SNIFF_BYTES * 2));
    const type = sniffImageType(head);
    return type ? `data:${type};base64,${base64FromHex(hex)}` : null;
  }

  const b64 = base64Head(s);
  if (b64) {
    const type = sniffImageType(b64);
    return type ? `data:${type};base64,${s}` : null;
  }

  return null;
}

/** True when `value` is a string that {@link imageSrcFrom} would resolve. */
export function looksLikeImage(value: unknown): boolean {
  return imageSrcFrom(value) !== null;
}

// -- shapes -----------------------------------------------------------------

/**
 * `value` as an indexable run of bytes, or null when it is not one. The whole
 * run, not a prefix: the same array is sniffed AND encoded, so the two can never
 * disagree about what the bytes are.
 */
function asBytes(value: unknown): ArrayLike<number> | null {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((n) => typeof n === 'number') ? (value as number[]) : null;
  }
  // `{0: 255, 1: 216, …}` — what a byte array becomes through JSON. It has no
  // `length`, so it has to be materialised before anything can slice it.
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    if (typeof o['0'] !== 'number') return null;
    const out: number[] = [];
    for (let i = 0; typeof o[String(i)] === 'number'; i++) out.push(o[String(i)] as number);
    return out;
  }
  return null;
}

/** The hex digits of a SQL blob literal or a bare hex string, else null. */
function hexBody(s: string): string | null {
  const lit = /^[xX]\s*(['"])([0-9a-fA-F]*)\1$/.exec(s);
  if (lit?.[2]) return lit[2];
  // Bare hex has to be long enough to carry a signature and even in length, or
  // any hexadecimal-looking word ("deadbeef" as a value) would qualify.
  if (s.length >= 8 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s)) return s;
  return null;
}

/** The first decoded bytes of a base64 string, or null when it is not base64. */
function base64Head(s: string): number[] | null {
  if (s.length < 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    // Decode only the prefix: a 10 MB photo does not need decoding to be typed.
    const head = s.slice(0, Math.ceil((SNIFF_BYTES * 4) / 3));
    const bin = atob(head.slice(0, head.length - (head.length % 4)));
    return [...bin].map((c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/**
 * Keep a `data:` URI that already names an image type; otherwise decide from its
 * own bytes, so an untyped or octet-stream BLOB still renders.
 */
function retypeDataUri(s: string): string | null {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(s);
  if (!m) return null;
  const declared = (m[1] ?? '').toLowerCase();
  if (declared.startsWith('image/')) return s;
  const body = m[3] ?? '';
  if (!m[2]) return null; // percent-encoded, not base64 — nothing to sniff
  const head = base64Head(body);
  const type = head && sniffImageType(head);
  return type ? `data:${type};base64,${body}` : null;
}

// -- encoding ---------------------------------------------------------------

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

/** base64 of a byte container, in chunks so a large photo does not blow the stack. */
function base64Of(bytes: ArrayLike<number>): string {
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = Array.prototype.slice.call(bytes, i, i + CHUNK) as number[];
    bin += String.fromCharCode(...slice);
  }
  return btoa(bin);
}

function base64FromHex(hex: string): string {
  return base64Of(hexToBytes(hex));
}
