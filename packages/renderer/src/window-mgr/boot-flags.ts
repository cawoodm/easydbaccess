// packages/renderer/src/window-mgr/boot-flags.ts
//
// URL flags that change how windows boot. Read once, at module load.
//
// These live in their own module because both `jspanel-manager.ts` (which
// opens panels) and `restack.ts` (which re-fronts them) need them, and
// jspanel-manager already imports restack — putting the flag in either of those
// would make the import cycle.

/**
 * `?minimize` — open every window minimized, so nothing mounts a grid or
 * fetches rows until the user expands it. The escape hatch for a workspace
 * whose tables are big enough to kill the tab on load.
 *
 * Transient, never persisted: the stored `windowGeometry.minimized` flags are
 * left exactly as they were, so reloading WITHOUT the flag restores the
 * user's real layout. Anything that acts on "is this window minimized" during
 * a forced-minimize boot must therefore ask THIS, not the stored geometry.
 */
export const FORCE_MINIMIZED = ((): boolean => {
  const v = new URLSearchParams(location.search).get('minimize');
  if (v === null) return false; // param absent
  return !/^(0|false|no)$/i.test(v); // bare `?minimize` counts as on
})();
