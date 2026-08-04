import { describe, expect, it } from 'vitest';
import { hasSecretRef, holdsRawSecret, isRawSecret, looksSecretName, resolvesToSameSecret, withoutRawSecrets } from '../../../packages/renderer/src/db/secret-guard.js';

/**
 * A credential may leave the device only as a `${secret:name}` reference. These
 * are the two halves of that rule: what must not be pushed, and what must not
 * overwrite a reference in the first place.
 */

describe('isRawSecret', () => {
  it('says yes to a value that is the secret itself', () => {
    expect(isRawSecret('ghp_realtoken')).toBe(true);
  });

  it('says no to a reference, and to anything empty', () => {
    expect(isRawSecret('${secret:gist_token}')).toBe(false);
    // A reference with text around it still carries no secret of its own.
    expect(isRawSecret('Bearer ${secret:tok}')).toBe(false);
    expect(isRawSecret('')).toBe(false);
    expect(isRawSecret('   ')).toBe(false);
    expect(isRawSecret(null)).toBe(false);
    expect(isRawSecret(undefined)).toBe(false);
    // Not a string: a number or flag is not a credential.
    expect(isRawSecret(42)).toBe(false);
  });

  it('agrees with hasSecretRef on what a reference is', () => {
    expect(hasSecretRef('${secret:a}')).toBe(true);
    expect(hasSecretRef('plain')).toBe(false);
  });
});

describe('looksSecretName', () => {
  it.each(['gist-sync:gist_token', 'datasette:token:https://x.dev', 'x:api_key', 'x:apikey', 'x:password', 'x:auth', 'x:credentials', 'x:pat', 'secret'])('reads %s as a credential', (name) => {
    expect(looksSecretName(name)).toBe(true);
  });

  it.each(['grid:sortDescFirst', 'preview:maxChars', 'x:tokenizer', 'x:keyboard', 'x:author'])('does not read %s as one', (name) => {
    expect(looksSecretName(name)).toBe(false);
  });
});

describe('holdsRawSecret', () => {
  it('catches a credential-named setting holding its own value', () => {
    expect(holdsRawSecret({ name: 'gist-sync:gist_token', value: 'ghp_x' })).toBe(true);
    // The one written straight into the settings table, past the dialog.
    expect(holdsRawSecret({ name: 'datasette:token:https://x.dev', value: 'dstok' })).toBe(true);
  });

  it('passes the same setting when it holds a reference or nothing', () => {
    expect(holdsRawSecret({ name: 'gist-sync:gist_token', value: '${secret:tok}' })).toBe(false);
    expect(holdsRawSecret({ name: 'gist-sync:gist_token', value: '' })).toBe(false);
  });

  it('catches a secret inside a composite record, through its member name', () => {
    // The legacy `gist:<id>` value predates references entirely.
    const legacy = { name: 'gist:default', value: { user: 'marc', gistId: 'abc', token: 'ghp_x' } };
    expect(holdsRawSecret(legacy)).toBe(true);
    const referenced = { name: 'gist:default', value: { user: 'marc', token: '${secret:t}' } };
    expect(holdsRawSecret(referenced)).toBe(false);
  });

  it('leaves an ordinary setting alone, whatever it holds', () => {
    expect(holdsRawSecret({ name: 'server-sync:url', value: 'https://s.dev' })).toBe(false);
    expect(holdsRawSecret({ name: 'grid:sortDescFirst', value: true })).toBe(false);
    expect(holdsRawSecret({ name: 'x:list', value: ['a', 'b'] })).toBe(false);
  });

  it("takes the caller's word for a field the name does not betray", () => {
    const s = { name: 'gist-sync:handshake', value: 'ghp_x' };
    expect(holdsRawSecret(s)).toBe(false);
    expect(holdsRawSecret(s, (n) => n === 'gist-sync:handshake')).toBe(true);
  });
});

describe('withoutRawSecrets', () => {
  it('keeps everything else and names what it withheld', () => {
    const { kept, withheld } = withoutRawSecrets([
      { name: 'server-sync:url', value: 'https://s.dev' },
      { name: 'gist-sync:gist_token', value: 'ghp_raw' },
      { name: 'gist-sync:user', value: 'marc' },
      { name: 'datasette:token:https://x.dev', value: '${secret:ds}' },
    ]);
    expect(kept.map((s) => s.name)).toEqual(['server-sync:url', 'gist-sync:user', 'datasette:token:https://x.dev']);
    expect(withheld).toEqual(['gist-sync:gist_token']);
  });

  it('drops the whole setting rather than pushing it blank', () => {
    // A blanked value would read as "the other device cleared this", and a pull
    // would then wipe a reference that is fine on the receiving side.
    const { kept } = withoutRawSecrets([{ name: 'x:token', value: 'raw' }]);
    expect(kept).toEqual([]);
  });

  it('passes an empty list through', () => {
    expect(withoutRawSecrets([])).toEqual({ kept: [], withheld: [] });
  });
});

describe('resolvesToSameSecret', () => {
  const secrets = { tok: 'ghp_real', other: 'zzz' };

  it('catches the write that would replace a reference with its own value', () => {
    expect(resolvesToSameSecret('${secret:tok}', 'ghp_real', secrets)).toBe(true);
    expect(resolvesToSameSecret('Bearer ${secret:tok}', 'Bearer ghp_real', secrets)).toBe(true);
  });

  it('allows a real edit — a different value, or a new reference', () => {
    expect(resolvesToSameSecret('${secret:tok}', 'ghp_other', secrets)).toBe(false);
    expect(resolvesToSameSecret('${secret:tok}', '${secret:other}', secrets)).toBe(false);
    // Clearing the field is a real edit too.
    expect(resolvesToSameSecret('${secret:tok}', '', secrets)).toBe(false);
  });

  it('says nothing when there is no reference to protect', () => {
    expect(resolvesToSameSecret('plain', 'plain', secrets)).toBe(false);
    expect(resolvesToSameSecret(undefined, 'ghp_real', secrets)).toBe(false);
    expect(resolvesToSameSecret('${secret:tok}', 42, secrets)).toBe(false);
  });

  it('leaves an unknown reference name alone — it resolves to itself', () => {
    // `interpolateSecrets` keeps an unknown token verbatim, so writing that same
    // literal text back is not a leak and not blocked.
    expect(resolvesToSameSecret('${secret:missing}', '${secret:missing}', secrets)).toBe(true);
  });
});
