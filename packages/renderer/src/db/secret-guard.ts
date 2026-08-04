/**
 * The rule that keeps a raw secret from leaving this device.
 *
 * A setting may hold a `${secret:name}` reference instead of a value: the
 * reference syncs, the secret behind it stays in device-local storage (see
 * `user-settings.ts`). The Settings dialog enforces that on the way in — a
 * `secret` field must be empty or a reference — but a value can still arrive by
 * another road. A plugin that reads a setting gets the RESOLVED value, and
 * writing it back replaced the reference with the secret itself; a legacy record
 * written before references existed holds one outright.
 *
 * So the push side checks too, and this module is that check. It is a net under
 * the dialog, not a substitute for it: nothing is repaired here, the offending
 * setting is simply left behind, and the caller says what it withheld.
 */

import { interpolateSecrets } from './user-settings.js';

/** Does the value carry a reference, and therefore nothing secret in itself? */
export function hasSecretRef(value: unknown): boolean {
  return typeof value === 'string' && value.includes('${secret:');
}

/**
 * Is this value a raw secret — text that is neither empty nor a reference?
 *
 * The same test the Settings dialog applies to a `secret` field (`rawSecret`).
 * Emptiness counts as safe: a blank field is how a secret is "not set".
 */
export function isRawSecret(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !hasSecretRef(value);
}

/**
 * Setting or property names that hold credentials. Used where the registered
 * field type is not available — a legacy composite record (`gist:<id>` holds
 * `{user, gistId, token}`) never went through a `SettingsFieldSpec` at all, and
 * it is exactly the kind of record that predates references.
 *
 * Word boundaries only, so `tokenizer` or `keyboard` are not credentials.
 */
const SECRET_NAME_RE = /(^|[_:.\-\s])(tokens?|secrets?|passwords?|passwd|pwd|api[_-]?keys?|apikeys?|auth|credentials?|pat)($|[_:.\-\s])/i;

/** Does a setting or property name read as a credential? */
export function looksSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

/** One setting, as far as this module cares. */
export interface NamedSetting {
  name: string;
  value: unknown;
}

/**
 * Does this setting hold a raw secret? True when the name reads as a credential
 * (or the caller's `isSecretField` says it is one) and the value is raw, or when
 * any credential-named property of an object value is raw — a composite record
 * leaks through its members, not through itself.
 */
export function holdsRawSecret(setting: NamedSetting, isSecretField?: (name: string) => boolean): boolean {
  const named = looksSecretName(setting.name) || isSecretField?.(setting.name) === true;
  if (named && isRawSecret(setting.value)) return true;
  const v = setting.value;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v as Record<string, unknown>).some(([k, member]) => looksSecretName(k) && isRawSecret(member));
}

/**
 * The settings that may be pushed, and the names of those that may not.
 *
 * Withholding the whole setting is deliberate: pushing it with the value blanked
 * would look like "the other device cleared this", and a pull would then wipe a
 * reference that is perfectly good on the receiving side.
 */
export function withoutRawSecrets<T extends NamedSetting>(settings: readonly T[], isSecretField?: (name: string) => boolean): { kept: T[]; withheld: string[] } {
  const kept: T[] = [];
  const withheld: string[] = [];
  for (const s of settings) {
    if (holdsRawSecret(s, isSecretField)) withheld.push(s.name);
    else kept.push(s);
  }
  return { kept, withheld };
}

/**
 * Would writing `next` over the stored value `raw` replace a reference with the
 * secret it resolves to?
 *
 * `SettingsApi.get` resolves references, so a plugin that reads a setting,
 * changes something else and writes it back hands the SECRET to `set` where the
 * reference used to be — that is how a `${secret:name}` setting "reset itself to
 * the resolved value". The stored reference is what the user typed, and the only
 * form that may sync, so a write like this is refused.
 *
 * A literal value that happens to equal the secret cannot be told apart from
 * this, and is refused too. That is the safe way round: the Settings dialog does
 * not accept a raw secret in a `secret` field either.
 */
export function resolvesToSameSecret(raw: unknown, next: unknown, secrets: Record<string, string>): boolean {
  if (typeof next !== 'string' || next === '') return false;
  if (!hasSecretRef(raw)) return false;
  return interpolateSecrets(raw as string, secrets) === next;
}
