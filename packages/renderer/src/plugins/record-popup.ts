// packages/renderer/src/plugins/record-popup.ts
//
// Who owns a double-click on a grid row.
//
// Three plugins want that one gesture and only one of them may have it:
//
//  - a docked **record pane** selects the row it draws (`table/current-row.ts`),
//  - the **record window** pops that record up in a panel of its own (here),
//  - the **record form** opens as it always has (`plugins/edit-record.ts`).
//
// They are answered in that order, and each hand-off is a question the previous
// module can answer without knowing who is asking. This file is the second one:
// "is there a record window to open?" — which is true exactly while the `Record`
// visualization is loaded, because that plugin is what registers the opener.
//
// A registry rather than an import, for the reason `current-row.ts` sets out: the
// two plugins must not import each other. `edit-record` can be switched off on
// its own, `viz-record` can be switched off on its own, and neither knows the
// other exists. It also makes the rule unit-testable with no DOM and no store.
//
// **Not the window itself.** `record-window.ts` reaches the store, the panel
// shell and the `<viz-record>` element; this module is three lines of state, so
// that `edit-record` can ask the question without pulling any of that into the
// module graph of the document-wide double-click listener.

/** Opens the record window. Registered by `plugins/viz-record.ts`'s `load`. */
export type RecordPopupOpener = (tableId: string, rowId: string) => void;

let opener: RecordPopupOpener | null = null;

/**
 * Offer the record window. Returns the release, like every other registry here.
 *
 * Last writer wins, deliberately: a plugin reloaded in place should replace its
 * own opener rather than be refused.
 */
export function provideRecordPopup(fn: RecordPopupOpener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Is a record window available at all? */
export function recordPopupWanted(): boolean {
  return opener !== null;
}

/**
 * Open the record window, and say whether it happened.
 *
 * The boolean is the hand-off: a caller that gets `false` still owns the
 * gesture and goes on to whatever it did before.
 */
export function openRecordPopup(tableId: string, rowId: string): boolean {
  if (!opener || !tableId || !rowId) return false;
  opener(tableId, rowId);
  return true;
}

/** Test seam. */
export function __resetRecordPopup(): void {
  opener = null;
}
