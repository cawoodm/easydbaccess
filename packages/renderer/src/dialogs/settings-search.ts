// packages/renderer/src/dialogs/settings-search.ts
//
// Finding a setting without knowing which tab it is on.
//
// The dialog has a tab per feature and the list keeps growing — Table grid,
// Links, Windows, Visualizations, Buttons, plus one for every plugin that
// registers fields. A user looking for "the thing that stops the pink cells"
// knows the words, not the tab, and the only way to find it was to open each tab
// and read. So a query searches every field of every tab at once, and the panel
// shows what matched with the tab it came from as its heading.
//
// Pure, so the rule can be pinned by unit tests: the dialog is a Lit element and
// the unit suite has no DOM.

import type { SettingsFieldSpec } from '@easydb/shared';

export interface SearchTab {
  id: string;
  name: string;
  fields: readonly SettingsFieldSpec[];
}

export interface SearchGroup {
  id: string;
  name: string;
  fields: SettingsFieldSpec[];
}

/**
 * The words a query is made of, lower-cased. Every one has to match (AND), which
 * is what makes a second word narrow rather than widen — "map tile" should find
 * the tile URL and not every field with a map in its description.
 */
export function searchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/**
 * The text one field is searched through.
 *
 * The TAB NAME is part of it on purpose: "windows" finds that tab's fields whole,
 * and a field's own label rarely repeats the feature it belongs to. So is the
 * `key`, which is what a plugin's docs and this repo's code call the setting, and
 * the `description` / `help` prose, which is where the words a user actually
 * remembers live — "pink", "clipboard", "one page at a time".
 */
export function fieldHaystack(tabName: string, f: SettingsFieldSpec): string {
  return [tabName, f.label, f.key, f.description ?? '', f.help ?? '', ...(f.options ?? [])].join(' ').toLowerCase();
}

/**
 * `terms` normally arrives from {@link searchTerms} and is already lower-cased;
 * it is lower-cased again here so a caller passing raw words cannot silently get
 * "no matches" out of a search that plainly should match.
 */
export function fieldMatches(tabName: string, f: SettingsFieldSpec, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const hay = fieldHaystack(tabName, f);
  return terms.every((t) => hay.includes(t.toLowerCase()));
}

/**
 * Every field that matches, grouped by the tab it belongs to and in tab order.
 * A tab with no match is left out entirely rather than shown empty.
 *
 * An empty query returns nothing, not everything — the caller shows the active
 * tab in that case, which is the dialog as it always was.
 */
export function matchSettings(tabs: readonly SearchTab[], query: string): SearchGroup[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];
  const out: SearchGroup[] = [];
  for (const tab of tabs) {
    const fields = tab.fields.filter((f) => fieldMatches(tab.name, f, terms));
    if (fields.length > 0) out.push({ id: tab.id, name: tab.name, fields });
  }
  return out;
}

/** How many fields matched, for a "3 settings" line above the results. */
export function countFields(groups: readonly SearchGroup[]): number {
  return groups.reduce((n, g) => n + g.fields.length, 0);
}
