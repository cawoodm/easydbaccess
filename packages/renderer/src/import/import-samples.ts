// packages/renderer/src/import/import-samples.ts
//
// The list behind the Import dialog's "Sample source" dropdown: the curated
// starting points we ship, plus the ones the user added, minus the ones the user
// deleted.
//
// The user owns this list. A shipped sample is a suggestion, not furniture — an
// instance that has gone offline, or a dataset nobody here cares about, is
// clutter in a dropdown people use every day. And the URL a person imports from
// twice a week belongs in the same dropdown as ours.
//
// Deleting a shipped sample cannot remove it from the code, so it is recorded as
// HIDDEN by url. Two consequences worth knowing:
//   - if we ever change a shipped sample's url, the hidden entry stops matching
//     and the sample comes back. That is the honest outcome: a different url is
//     a different sample.
//   - nothing is lost, so "Restore samples" can simply clear the hidden list.
//
// Pure data + pure functions (no Lit, no DOM, no store) so the merge and the
// tolerant parse can be tested directly.

/** How a sample's URL should be imported. Absent ⇒ let the dialog auto-detect. */
export type ImportSampleKind = 'json' | 'csv' | 'sql' | 'datasette';

/** One entry in the dropdown. */
export interface ImportSample {
  label: string;
  url: string;
  kind?: ImportSampleKind | undefined;
}

/** A sample the USER added, kept in the workspace settings. */
export interface UserImportSample extends ImportSample {
  /** Stable identity for delete — labels are free text and may repeat. */
  id: string;
}

/**
 * Settings keys. Workspace settings rather than device-local ones: which
 * datasets a workspace imports from is part of that workspace, so the list
 * should travel with it through a gist push or a dump.
 */
export const IMPORT_SAMPLES_SETTING = 'import:samples';
export const IMPORT_SAMPLES_HIDDEN_SETTING = 'import:samplesHidden';

/** One row of the dropdown, ready to render. */
export interface SampleEntry extends ImportSample {
  /** `b:<url>` for a shipped sample, `u:<id>` for the user's own. */
  key: string;
  /** The user's own, so a delete removes it rather than hiding it. */
  own: boolean;
}

/**
 * What the dropdown shows: the shipped samples the user has not deleted, then
 * the user's own in the order they were added.
 */
export function sampleEntries(builtin: ReadonlyArray<ImportSample>, user: ReadonlyArray<UserImportSample>, hidden: ReadonlyArray<string>): SampleEntry[] {
  const gone = new Set(hidden);
  const out: SampleEntry[] = [];
  for (const s of builtin) {
    if (gone.has(s.url)) continue;
    out.push({ ...s, key: `b:${s.url}`, own: false });
  }
  for (const s of user) out.push({ ...s, key: `u:${s.id}`, own: true });
  return out;
}

/**
 * Read the stored user list, tolerating anything. The value comes back from a
 * store that may have been synced from another device or hand-edited in a dump,
 * so a malformed entry is dropped rather than allowed to break the dialog — a
 * broken sample list must not cost the user their Import button.
 */
export function parseUserSamples(value: unknown): UserImportSample[] {
  const raw = typeof value === 'string' ? tryParseJson(value) : value;
  if (!Array.isArray(raw)) return [];
  const out: UserImportSample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, label, url, kind } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    if (typeof label !== 'string' || !label.trim()) continue;
    if (typeof url !== 'string' || !url.trim()) continue;
    // An unreadable kind is dropped, not the sample: auto-detect is a fine
    // answer for a URL, and losing the entry would not be.
    out.push({ id, label: label.trim(), url: url.trim(), ...(isSampleKind(kind) ? { kind } : {}) });
  }
  return out;
}

/** Read the stored hidden-url list, tolerating anything. */
export function parseHiddenSamples(value: unknown): string[] {
  const raw = typeof value === 'string' ? tryParseJson(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === 'string' && !!u.trim()).map((u) => u.trim());
}

function isSampleKind(v: unknown): v is ImportSampleKind {
  return v === 'json' || v === 'csv' || v === 'sql' || v === 'datasette';
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** `all` with one more sample appended. Pure — the caller persists the result. */
export function addUserSample(all: ReadonlyArray<UserImportSample>, sample: UserImportSample): UserImportSample[] {
  return [...all, sample];
}

/** `all` without the sample carrying `id`. */
export function removeUserSample(all: ReadonlyArray<UserImportSample>, id: string): UserImportSample[] {
  return all.filter((s) => s.id !== id);
}

/** `hidden` with one more url, never duplicated. */
export function hideSample(hidden: ReadonlyArray<string>, url: string): string[] {
  return hidden.includes(url) ? [...hidden] : [...hidden, url];
}
