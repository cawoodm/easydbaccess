// packages/renderer/src/window-mgr/table-kind.ts
//
// Single source of truth for classifying a table's "kind" from its
// `source`/`origin` fields, plus the small inline SVGs shown at the far left
// of its panel titlebar (the panel shell's `headerLogo` slot — see
// table-window-manager.ts and view-window-manager.ts). `dialogs/table-info-dialog.ts`'s
// `describeProvenance()` classifies via `tableKind()` too, so the (i) dialog's
// prose and the titlebar icon can never drift apart.

import type { Table } from '@easydb/shared';

/**
 * How a table's rows are sourced — drives both the titlebar icon and the
 * (i) dialog's "Kind" prose. Views are not tables (no `source`/`origin` to
 * classify) and get their own fixed icon (`VIEW_ICON` below), so they're not
 * part of this union.
 */
export type TableKind = 'normal' | 'imported' | 'referenced' | 'connected' | 'projection';

/**
 * Classify a table. `source` wins over `origin` when a table somehow carries
 * both: a live `source` always routes reads to the remote provider (see
 * `routed-data-store.ts`), so the table behaves as connected/referenced
 * regardless of how it originally arrived — live routing wins.
 *
 * Only `'url'` (plugins/url-source.ts) and `'datasette'`
 * (plugins/datasette-source.ts) are registered `source.type`s today; any
 * other/future non-`'url'` type is treated as `'connected'`.
 */
export function tableKind(t: Pick<Table, 'source' | 'origin'>): TableKind {
  // A projection carries a `source` like a remote does, but nothing about it is
  // remote: it is computed from other tables in THIS workspace. Classified apart
  // so it stops reading as "connected to a live backend" in the (i) dialog and
  // stops wearing the plug icon.
  if (t.source?.type === 'projection') return 'projection';
  if (t.source) return t.source.type === 'url' ? 'referenced' : 'connected';
  if (t.origin) return 'imported';
  return 'normal';
}

/**
 * A table has a Refresh button (datasette-source.ts `datasette:refresh`,
 * import-data.ts `import-data:refresh`, url-source.ts `url-source:refresh`)
 * whenever it carries a `source` OR an `origin` — i.e. every kind except
 * `'normal'`. Also drives {@link panelColor}, which gives refreshable tables a
 * distinct titlebar colour.
 */
export function isRefreshable(t: Pick<Table, 'source' | 'origin'>): boolean {
  return !!(t.source || t.origin);
}

/**
 * **Every table is blue.** One shade per kind, so how a table is sourced reads
 * at a glance — but a table always looks like a table, and the family says so
 * before the shade says which sort.
 *
 * That is the rule the palette used to break. Refreshable tables were violet
 * `#6d28d9` and a visualization window was violet `#7c3aed`: two colours nobody
 * can tell apart, on two things that are not remotely the same kind of object.
 * Non-blue is now reserved for what is NOT a table — teal for a view, violet for
 * a visualization (see `view-window-manager.ts`).
 *
 * Every value here clears WCAG AA against the white titlebar text; the ramp runs
 * roughly darkest-for-most-remote, and `imported` is the lightest because a
 * snapshot is the most local of the non-local kinds.
 */
export const PANEL_COLORS: Record<TableKind, string> = {
  /** Plain local table — jsPanel's old 'primary' theme colour. ~7.2:1. */
  normal: '#01579b',
  /** Pulled in once, lives here now. ~4.8:1. */
  imported: '#0277bd',
  /** Points at a URL, holds nothing locally. ~5.7:1. */
  referenced: '#1565c0',
  /** Live connection to a remote backend. ~8.6:1. */
  connected: '#0d47a1',
  /** Computed from other tables in this workspace. ~7.7:1. */
  projection: '#3949ab',
};

/** A plain local table's chrome. Kept as a named export — callers outside the
 *  kind machinery (the panel shell's default) mean THIS one specifically. */
export const PANEL_COLOR_LOCAL = PANEL_COLORS.normal;

/**
 * The titlebar colour for a table, so how it is sourced reads at a glance.
 * Handed to the panel shell as its `color`, which is what BOTH the window and
 * its minimized dock bar paint from — the colour used to be a CSS class over the
 * window only, so a docked window changed colour.
 */
export function panelColor(t: Pick<Table, 'source' | 'origin'>): string {
  return PANEL_COLORS[tableKind(t)];
}

/** Shared attributes for every titlebar icon — matches the style of plugin
 * `meta.icon` strings (dump-export.ts, cell-boolean.ts, views.ts), sized to
 * sit comfortably in a panel titlebar (~14–16px). */
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" role="img"';

/**
 * Inline SVGs shown at the far left of a table's panel titlebar, one per
 * `TableKind`. Each carries a `title` + `aria-label` naming the kind, so the
 * icon is never the only cue — it's the same information `describeProvenance`
 * states in prose.
 */
export const TABLE_KIND_ICONS: Record<TableKind, string> = {
  // Plain grid — a plain local table.
  normal: `<svg ${ICON_ATTRS} aria-label="Local table"><title>Local table</title><rect x="3" y="3" width="18" height="18" rx="1"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/></svg>`,
  // Grid with a down-arrow feeding into it — pulled in once, lives locally now.
  imported: `<svg ${ICON_ATTRS} aria-label="Imported table (snapshot)"><title>Imported table (snapshot)</title><rect x="3" y="11" width="18" height="10" rx="1"/><line x1="7" y1="15" x2="7" y2="17"/><line x1="12" y1="15" x2="12" y2="17"/><line x1="17" y1="15" x2="17" y2="17"/><path d="M12 2v7"/><polyline points="8 6 12 9 16 6"/></svg>`,
  // Chain link — points elsewhere, holds nothing locally.
  referenced: `<svg ${ICON_ATTRS} aria-label="Referenced table (read-only)"><title>Referenced table (read-only)</title><path d="M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1"/><path d="M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1"/></svg>`,
  // Plug — live connection to a remote backend.
  connected: `<svg ${ICON_ATTRS} aria-label="Connected table (live)"><title>Connected table (live)</title><line x1="9" y1="2" x2="9" y2="7"/><line x1="15" y1="2" x2="15" y2="7"/><rect x="6" y="7" width="12" height="7" rx="2"/><path d="M9 14v3a3 3 0 0 0 6 0v-3"/></svg>`,
  // Two boxes merging into one — computed from other tables in this workspace.
  projection: `<svg ${ICON_ATTRS} aria-label="Projection (computed from other tables)"><title>Projection (computed from other tables)</title><rect x="2" y="3" width="8" height="7" rx="1"/><rect x="2" y="14" width="8" height="7" rx="1"/><path d="M10 6.5h4a2 2 0 0 1 2 2v5"/><path d="M10 17.5h4a2 2 0 0 0 2-2v-2"/><rect x="14" y="13" width="8" height="0.01"/><polyline points="13 10 16 13 19 10"/></svg>`,
};

/**
 * View windows aren't tables, so they're drawn once at open time
 * (view-window-manager.ts) — a view's kind never changes at runtime, unlike a
 * table's. Same eye glyph as the `views` plugin's own `meta.icon` (views.ts).
 */
export const VIEW_ICON = `<svg ${ICON_ATTRS} aria-label="View"><title>View</title><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

/**
 * A visualization window or docked pane. A viz is a KIND of view (its definition
 * is a `ViewTemplate` whose `kind` is `'viz'`), but it reads as a different thing
 * on screen, so it gets its own glyph and its own chrome colour rather than
 * sharing the eye.
 */
export const VIZ_ICON = `<svg ${ICON_ATTRS} aria-label="Visualization"><title>Visualization</title><path d="M3 3v18h18"/><rect x="6" y="12" width="3" height="6"/><rect x="11" y="8" width="3" height="10"/><rect x="16" y="5" width="3" height="13"/></svg>`;
