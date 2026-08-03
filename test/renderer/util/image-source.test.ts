import { describe, expect, it } from 'vitest';
import {
  imageSrcFrom,
  looksLikeImage,
  sniffImageType,
} from '../../../packages/renderer/src/util/image-source.js';

/** The real leading bytes of each format, as a database BLOB would hold them. */
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00];
const BMP = [0x42, 0x4d, 0x36, 0x00, 0x00, 0x00, 0x00, 0x00];
const WEBP = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
];

const hex = (bytes: number[]) => bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('sniffImageType', () => {
  it('reads the type from the bytes', () => {
    expect(sniffImageType(JPEG)).toBe('image/jpeg');
    expect(sniffImageType(PNG)).toBe('image/png');
    expect(sniffImageType(GIF)).toBe('image/gif');
    expect(sniffImageType(BMP)).toBe('image/bmp');
    expect(sniffImageType(WEBP)).toBe('image/webp');
  });

  it('is null for anything else', () => {
    expect(sniffImageType([0x50, 0x4b, 0x03, 0x04])).toBeNull(); // a zip
    expect(sniffImageType([])).toBeNull();
  });

  it('needs WEBP at offset 8, not just RIFF', () => {
    const riffOnly = [...WEBP];
    riffOnly[8] = 0x41; // "AEBP"
    expect(sniffImageType(riffOnly)).toBeNull();
  });
});

describe('imageSrcFrom — URLs and data URIs', () => {
  it('keeps a data: URI that already names an image type', () => {
    const uri = `data:image/png;base64,${b64(PNG)}`;
    expect(imageSrcFrom(uri)).toBe(uri);
  });

  it('re-types an octet-stream data URI from its own bytes', () => {
    // What a BLOB export looks like: right bytes, useless declared type.
    const body = b64(JPEG);
    expect(imageSrcFrom(`data:application/octet-stream;base64,${body}`)).toBe(
      `data:image/jpeg;base64,${body}`,
    );
    expect(imageSrcFrom(`data:;base64,${body}`)).toBe(`data:image/jpeg;base64,${body}`);
  });

  it('rejects a data URI whose bytes are not an image', () => {
    expect(imageSrcFrom(`data:text/plain;base64,${btoa('hello there')}`)).toBeNull();
  });

  it('takes an http(s) or protocol-relative URL on shape alone', () => {
    expect(imageSrcFrom('https://x/y.png')).toBe('https://x/y.png');
    expect(imageSrcFrom('http://accweb/emmployees/davolio.bmp')).toBe(
      'http://accweb/emmployees/davolio.bmp',
    );
    expect(imageSrcFrom('//cdn/x.jpg')).toBe('//cdn/x.jpg');
  });

  it('takes a root-relative path only with an image extension', () => {
    expect(imageSrcFrom('/img/a.jpeg')).toBe('/img/a.jpeg');
    expect(imageSrcFrom('/notes')).toBeNull();
  });
});

describe('imageSrcFrom — SQL blob literals', () => {
  it('reads a northwind Photo, the shape a .sql dump carries', () => {
    // Employees.Photo in northwind.db is a JPEG BLOB, dumped as X'ffd8ffe0…'.
    expect(imageSrcFrom(`X'${hex(JPEG)}'`)).toBe(`data:image/jpeg;base64,${b64(JPEG)}`);
  });

  it('accepts either quote style and a lower-case x', () => {
    expect(imageSrcFrom(`x"${hex(PNG)}"`)).toBe(`data:image/png;base64,${b64(PNG)}`);
  });

  it('accepts bare hex', () => {
    expect(imageSrcFrom(hex(GIF))).toBe(`data:image/gif;base64,${b64(GIF)}`);
  });

  it('refuses hex whose bytes are not an image', () => {
    expect(imageSrcFrom("X'504b0304deadbeef'")).toBeNull();
  });

  it('is not fooled by short or odd hexadecimal-looking text', () => {
    expect(imageSrcFrom('deadbeef')).toBeNull(); // valid hex, not an image
    expect(imageSrcFrom('ffd8ff')).toBeNull(); // too short to judge
  });
});

describe('imageSrcFrom — bytes and base64', () => {
  it('reads a Uint8Array', () => {
    expect(imageSrcFrom(new Uint8Array(JPEG))).toBe(`data:image/jpeg;base64,${b64(JPEG)}`);
  });

  it('reads a plain number array', () => {
    expect(imageSrcFrom(PNG)).toBe(`data:image/png;base64,${b64(PNG)}`);
  });

  it('reads the {0: 255, 1: 216, …} object a byte array becomes in JSON', () => {
    const asObject: Record<string, number> = {};
    JPEG.forEach((b, i) => (asObject[String(i)] = b));
    expect(imageSrcFrom(asObject)).toBe(`data:image/jpeg;base64,${b64(JPEG)}`);
  });

  it('reads bare base64', () => {
    expect(imageSrcFrom(b64(BMP))).toBe(`data:image/bmp;base64,${b64(BMP)}`);
  });

  it('refuses bytes that are not an image', () => {
    expect(imageSrcFrom(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBeNull();
    expect(imageSrcFrom([])).toBeNull();
  });

  it('handles a photo far bigger than one encoding chunk', () => {
    // 100 KB: the chunked base64 must not blow the argument limit.
    const big = new Uint8Array(100_000);
    JPEG.forEach((b, i) => (big[i] = b));
    const src = imageSrcFrom(big)!;
    expect(src.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});

describe('imageSrcFrom — nothing to show', () => {
  it('is null for empty, null and ordinary text', () => {
    expect(imageSrcFrom(null)).toBeNull();
    expect(imageSrcFrom(undefined)).toBeNull();
    expect(imageSrcFrom('')).toBeNull();
    expect(imageSrcFrom('   ')).toBeNull();
    expect(imageSrcFrom('Sales Representative')).toBeNull();
    expect(imageSrcFrom(42)).toBeNull();
  });

  it('looksLikeImage agrees with imageSrcFrom', () => {
    expect(looksLikeImage(`X'${hex(JPEG)}'`)).toBe(true);
    expect(looksLikeImage('Sales Representative')).toBe(false);
  });
});
