/**
 * The one way to open the Views manager, for callers that must not depend on it.
 *
 * `views-dialog.ts` is 1400+ lines and imports half the viz layer. The modules
 * that need to OPEN it are leaves — a view window's footer, the viz pane's edit
 * buttons — and importing it from there closed two import cycles:
 *
 *   views-dialog → view-window-manager → view-window → views-dialog
 *   views-dialog → view-window-manager → viz-pane    → views-dialog
 *
 * The dialog legitimately needs the manager (`revealViewWindow`), so the edge to
 * break is the one coming back. A dynamic `import()` is not a static edge in the
 * module graph, so routing every caller through here breaks both cycles without
 * any registration handshake to bootstrap — and nothing has to be loaded in the
 * right order for a button to work.
 *
 * It also makes the dialog LAZY. It used to be in the boot bundle because the
 * `views` plugin is a built-in and statically imported it; now it is fetched the
 * first time someone asks for it. This is the same pattern as the other ~17
 * `await import('../dialogs/…')` sites in the app.
 */

/**
 * Where to land inside the manager. `editTemplateId` jumps straight into editing
 * that template, `editInstanceId` into that view instance (rename / re-map) —
 * both used by the icon buttons in a view window's footer and the viz pane strip.
 *
 * Declared here rather than imported from the dialog, so that even a TYPE import
 * does not put an edge back — the tools that draw the module graph read source,
 * not emitted JS, and would report the erased import as a cycle. The shape is
 * checked against the real parameter where `openViewsDialog` is called below.
 */
export interface ViewsTarget {
  editTemplateId?: string;
  editInstanceId?: string;
}

/**
 * Open the Views manager for a table, loading it on first use.
 *
 * Fire-and-forget from a click handler: `void openViews(id)`. The returned
 * promise settles once the dialog module is loaded and `open()` has been called,
 * which is what the tests await.
 */
export async function openViews(tableId: string, opts?: ViewsTarget): Promise<void> {
  const { openViewsDialog } = await import('./views-dialog.js');
  openViewsDialog(tableId, opts);
}
