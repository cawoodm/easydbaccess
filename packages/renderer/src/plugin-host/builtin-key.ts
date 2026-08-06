/**
 * Synthetic URL used to key a built-in plugin's disable state in the `plugins`
 * collection.
 *
 * Its own module (rather than `loader.ts`) so a built-in plugin can disable
 * ITSELF without importing the loader that imports it — the `tips` plugin does
 * exactly that when the user ticks "Don't show again".
 */
export function builtinKey(id: string): string {
  return `builtin:${id}`;
}
