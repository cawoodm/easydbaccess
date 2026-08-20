/**
 * The physical primary key of a setting.
 *
 * Settings are workspace-scoped but live in one flat collection, so the stored
 * key composes the workspace with the setting's logical name. `::` separates
 * them — a workspace id is a slug (see `slugifyWorkspace`), so it never contains
 * one.
 *
 * This lives in `shared` rather than in any one store because every backend
 * agrees on it: the `settings` view in the renderer's `data-store-bridge.ts`
 * builds keys with it, and `EdbStore` reads them back out of `_easydb` on both
 * the desktop and the browser. A store that invented its own spelling would
 * write settings the others could not find.
 */
export function settingId(workspaceId: string, name: string): string {
  return `${workspaceId}::${name}`;
}
