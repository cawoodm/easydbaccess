// The command palette's "Recent" section. Pure list arithmetic, kept out of
// command-palette-dialog.ts so it can be unit-tested without a DOM.

/** How many commands the palette remembers. */
export const RECENT_MAX = 5;

/** Workspace-scoped setting holding the ids, most recent first. */
export const RECENT_SETTING = 'palette:recent';

/** The group name a remembered command is shown under. */
export const RECENT_GROUP = 'Recent';

/** Only the shape `orderByRecent` needs — the dialog's PaletteItem satisfies it. */
interface Grouped {
  id: string;
  group: string;
}

/**
 * `id` first, then the previous ids without it, capped at {@link RECENT_MAX}.
 * Re-running a command that is already remembered moves it to the front rather
 * than adding a second entry.
 */
export function pushRecent(ids: readonly string[], id: string, max = RECENT_MAX): string[] {
  return [id, ...ids.filter((x) => x !== id)].slice(0, max);
}

/** Reads the setting's value back as ids, tolerating an absent or junk value. */
export function readRecent(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').slice(0, RECENT_MAX);
}

/**
 * Moves the remembered commands to the front of `items`, in `recentIds` order,
 * and re-groups them under {@link RECENT_GROUP}. A remembered id that no longer
 * resolves to an item (its table was deleted, its plugin was disabled) is
 * skipped.
 *
 * The items MOVE — they are not copied — so the palette never lists the same
 * command twice, and index 0 is always the last command that ran. That is what
 * makes Ctrl+K Enter a repeat of it.
 */
export function orderByRecent<T extends Grouped>(items: T[], recentIds: readonly string[]): T[] {
  if (recentIds.length === 0) return items;
  const byId = new Map(items.map((it) => [it.id, it] as const));
  const recent: T[] = [];
  for (const id of recentIds) {
    const it = byId.get(id);
    if (it) recent.push({ ...it, group: RECENT_GROUP });
  }
  if (recent.length === 0) return items;
  const taken = new Set(recent.map((it) => it.id));
  return [...recent, ...items.filter((it) => !taken.has(it.id))];
}
