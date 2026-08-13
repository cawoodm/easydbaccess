/**
 * The settings namespace the grid's own preferences live under.
 *
 * It sits in its own module because of the direction the dependencies have to
 * run: the `settings` plugin REGISTERS the fields (it owns the Settings tab) and
 * `<data-table>` READS them, and neither should import the other — a core
 * element importing a plugin would invert the plugin model, and a plugin
 * importing the grid would pull the whole element in for one string.
 */
export const GRID_SETTINGS_ID = 'grid';

/**
 * Does a first click on a column header sort DESCENDING? Read per click rather
 * than cached: a click is not a hot path, and a cache would still be showing the
 * old answer right after someone changed it in the Settings dialog (there is no
 * settings-changed event to invalidate on).
 *
 * Defaults to true when unset. Dates, scores, counts and prices are read from
 * the high end down, so ascending-first spent a click on the direction nobody
 * wanted; a column of names is the exception the setting exists for.
 */
export async function readSortDescFirst(settings: { get<T>(pluginId: string, key: string): Promise<T | undefined> }): Promise<boolean> {
  return (await settings.get<boolean>(GRID_SETTINGS_ID, 'sortDescFirst')) !== false;
}

/**
 * Does an empty cell get the pink background? Defaults to true when unset — the
 * highlight came first and a gap in the data is worth seeing.
 *
 * Unlike the sort setting this one is read into component state rather than per
 * use, because it is needed while painting every cell and a render cannot await
 * a store read. `settings-events.ts` is what tells the grid to read it again.
 */
export async function readHighlightNulls(settings: { get<T>(pluginId: string, key: string): Promise<T | undefined> }): Promise<boolean> {
  return (await settings.get<boolean>(GRID_SETTINGS_ID, 'highlightNulls')) !== false;
}

/**
 * Does a cell the last Validate run flagged get the same pink background?
 * Defaults to true when unset — a run the user asked for should be visible.
 *
 * Separate from {@link readHighlightNulls} because the two mark different things:
 * an empty cell may be empty on purpose (which is why that one can be switched
 * off), while a flagged cell breaks a rule the user themselves set. The reason in
 * the cell's tooltip is not behind this switch either way.
 */
export async function readHighlightErrors(settings: { get<T>(pluginId: string, key: string): Promise<T | undefined> }): Promise<boolean> {
  return (await settings.get<boolean>(GRID_SETTINGS_ID, 'highlightErrors')) !== false;
}

/**
 * Row count from which a grid stops holding the whole table and reads one PAGE at
 * a time (`grid:windowRowsFrom`). `0` never windows.
 *
 * 50 000 rather than something smaller so that every table which works well today
 * keeps the code path it has, and only the ones that hurt change: one measured
 * 609,283-row table cost 1483 ms and a 15.4 MB payload to put about thirty rows on
 * screen, where the same query for 200 rows takes 13 ms.
 *
 * Read into component state, like {@link readHighlightNulls} — the answer decides
 * what a fetch asks for, and a fetch cannot await a settings read per keystroke.
 */
export const WINDOW_ROWS_FROM_DEFAULT = 50_000;

export async function readWindowRowsFrom(settings: { get<T>(pluginId: string, key: string): Promise<T | undefined> }): Promise<number> {
  const raw: unknown = await settings.get<number>(GRID_SETTINGS_ID, 'windowRowsFrom');
  // `0` is a real answer — never window — so it must be told apart from "nothing
  // stored". `Number(null)` and `Number('')` are both 0, which would read a dump's
  // null or a cleared field as a deliberate 0 and quietly switch windowing off for
  // every table. Only a number, or a string that says one, counts.
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 0) return WINDOW_ROWS_FROM_DEFAULT;
  return Math.floor(n);
}
