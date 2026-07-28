/**
 * Boot-time safe mode: a URL-flag escape hatch for the "a plugin can kill the
 * app" failure mode (a URL-loaded or built-in plugin throwing during init/load,
 * or worse, hanging the tab before the Plugin Manager button is even usable).
 *
 * `SAFE_MODE` is resolved ONCE at module load from `location.search` and is
 * used purely to decide what to SKIP LOADING this boot:
 *   - `?safemode`  → `'all-optional'`: skip every URL plugin AND every
 *     non-`fixed` built-in. Only `meta.fixed` built-ins load (currently
 *     `core-renderers` and `settings`), so the grid still renders and the
 *     user can still open Settings and the (core-chrome) Plugin Manager to
 *     disable whatever is misbehaving.
 *   - `?safemode1` → `'url-plugins'`: skip only URL plugins; all built-ins
 *     load normally.
 *   - neither param → `'off'`: unchanged behavior.
 *
 * This is DELIBERATELY transient and MUST NEVER write to the `plugins`
 * collection or otherwise persist anything: it only changes what THIS boot
 * loads, not the user's real per-plugin enable/disable state. That's what
 * makes it safe to try — reloading without the flag restores the previous
 * behavior exactly, and the user's actual settings are never touched. If it
 * wrote state, a scary boot would permanently disable plugins the user never
 * asked to disable.
 *
 * If both params are present, `?safemode` (the stronger level) wins.
 *
 * Mirrors the existing `?minimize` boot-flag convention elsewhere in the
 * codebase: a bare flag or any truthy value turns it on, `=0` turns it off
 * (e.g. `?safemode`, `?safemode=1`, `?safemode=true` are all ON; `?safemode=0`
 * is OFF).
 */
export type SafeMode = 'off' | 'url-plugins' | 'all-optional';

function flagOn(sp: URLSearchParams, name: string): boolean {
  if (!sp.has(name)) return false;
  return sp.get(name) !== '0';
}

function resolveSafeMode(): SafeMode {
  if (typeof location === 'undefined') return 'off';
  const sp = new URLSearchParams(location.search);
  if (flagOn(sp, 'safemode')) return 'all-optional';
  if (flagOn(sp, 'safemode1')) return 'url-plugins';
  return 'off';
}

export const SAFE_MODE: SafeMode = resolveSafeMode();
