// packages/renderer/src/dialogs/settings-search.ts
//
// Finding a setting by name, across every tab.
//
// The dialog has grown past a dozen tabs, and the tab a setting lives in is an
// implementation fact — "which colours can a window be" is under Windows, but
// somebody looking for it may well try Table grid first. So the search is over
// ALL tabs at once and the answer names the tab it found each field in, rather
// than filtering the tab the user happens to be on.
//
// Pure, and unit-tested without the dialog: the matching rule is the whole of
// the feature, and the rest is rendering.

/** The searchable text of one field. A subset of `SettingsFieldSpec`. */
export interface SearchableField {
  key: string;
  label: string;
  description?: string | undefined;
  help?: string | undefined;
}

export interface SearchableTab {
  id: string;
  name: string;
  fields: readonly SearchableField[];
}

/** One tab's matches, in the order the tab lists its fields. */
export interface SettingsHit {
  tabId: string;
  tabName: string;
  keys: string[];
}

/**
 * The words a query is looking for.
 *
 * Split on whitespace, so `map tile` finds "Map tile URL template" without the
 * user having to reproduce the label. Every term must match (AND), because
 * adding a word to a search means narrowing it.
 */
export function searchTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Does this field answer the query?
 *
 * The haystack is everything the user can see or reasonably guess: the label,
 * the description, the help text, the tab's name — and the KEY, which is what a
 * doc page or a CHANGELOG entry calls the setting (`links:protocols`). Substring,
 * not prefix: a search for "colour" has to find "Colours a window can be
 * painted".
 */
export function fieldMatches(field: SearchableField, tabName: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [tabName, field.key, field.label, field.description ?? '', field.help ?? ''].join('\n').toLowerCase();
  // The terms are lowercased again here, not only in `searchTerms`: a function
  // that silently matches nothing when handed `COLOURS` is a trap for the next
  // caller, and one `toLowerCase` per term costs nothing.
  return terms.every((t) => haystack.includes(t.toLowerCase()));
}

/**
 * Every match, grouped by tab, tabs in their registered order.
 *
 * A tab with no match is left out entirely rather than listed empty — the result
 * list is meant to be short, and an empty group says nothing.
 */
export function searchSettings(tabs: readonly SearchableTab[], query: string): SettingsHit[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const hits: SettingsHit[] = [];
  for (const tab of tabs) {
    const keys = tab.fields.filter((f) => fieldMatches(f, tab.name, terms)).map((f) => f.key);
    if (keys.length > 0) hits.push({ tabId: tab.id, tabName: tab.name, keys });
  }
  return hits;
}

/** How many fields matched in total — what the header reports. */
export function hitCount(hits: readonly SettingsHit[]): number {
  return hits.reduce((n, h) => n + h.keys.length, 0);
}

/** Matches per tab id, for the count beside each tab in the nav. */
export function hitsByTab(hits: readonly SettingsHit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of hits) out[h.tabId] = h.keys.length;
  return out;
}
