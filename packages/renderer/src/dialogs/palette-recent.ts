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
 * The remembered ids that still resolve to something, in order.
 *
 * A "Go to <table>" command's id carries the table's id (`goto:<tableId>`, and
 * `goto-view:<id>` for a view), so deleting the table leaves an id here that
 * names nothing. `orderByRecent` already skips it, but it goes on occupying one
 * of the {@link RECENT_MAX} slots — five deleted tables and the Recent section is
 * empty while looking full.
 *
 * Pruned on READ rather than on delete: a table can leave in several ways (the
 * trash button, a workspace delete, a sync that pulls a workspace without it),
 * and every one of them would have to remember to call a cleanup. Checked against
 * the commands that actually exist, it needs no such cooperation.
 */
export function pruneRecent(ids: readonly string[], knownIds: Iterable<string>): string[] {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  return ids.filter((id) => known.has(id));
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
