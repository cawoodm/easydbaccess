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
export async function readSortDescFirst(settings: {
  get<T>(pluginId: string, key: string): Promise<T | undefined>;
}): Promise<boolean> {
  return (await settings.get<boolean>(GRID_SETTINGS_ID, 'sortDescFirst')) !== false;
}
