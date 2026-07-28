/**
 * Panel titlebar behavior that jsPanel doesn't provide:
 *
 *  1. Double-click a titlebar to maximize it, double-click again to restore.
 *  2. Show a `pointer` cursor on a maximized panel's drag handles instead of
 *     `move`. jsPanel's `dragit.disableOnMaximized` default is `true`, so a
 *     maximized panel genuinely CANNOT be dragged — keeping the `move` cursor
 *     there advertises a drag that does nothing. `pointer` matches what the
 *     titlebar really offers while maximized: a double-click to restore.
 *
 * Both work off the DOM — the `.jsPanel` element carries the panel API, and
 * jsPanel fires `jspanelstatuschange` on `document` with the panel's id as the
 * event detail — so one set of listeners covers table windows and view windows
 * with no per-panel wiring and no registry to keep in sync.
 *
 * Double-clicks on the titlebar's interactive contents are ignored: the control
 * buttons, and the per-table search box injected into the controlbar (where a
 * double-click means "select a word", not "maximize").
 */

/** The subset of the jsPanel element API this module drives. */
type TogglePanel = HTMLElement & {
  status?: string;
  maximize?: (cb?: unknown, donotfront?: boolean) => void;
  normalize?: () => void;
};

/** Selector for titlebar contents where a double-click must NOT toggle. */
const INTERACTIVE = 'input, textarea, select, button, a, .jsPanel-controlbar';

/**
 * jsPanel's default `dragit.handles`. Each one gets an inline `cursor: move`
 * while the panel is draggable, so each one needs the swap when it stops being
 * draggable. (An inline style is why this can't be a plain CSS rule.)
 */
const DRAG_HANDLES = '.jsPanel-headerlogo, .jsPanel-titlebar, .jsPanel-ftr';

/** Each handle's original inline cursor, so restoring puts back what jsPanel set. */
const originalCursor = new WeakMap<HTMLElement, string>();

/** Point the drag handles' cursor at what the panel can actually do right now. */
function syncDragCursor(panel: TogglePanel): void {
  const maximized = panel.status === 'maximized';
  for (const handle of panel.querySelectorAll<HTMLElement>(DRAG_HANDLES)) {
    if (!originalCursor.has(handle)) originalCursor.set(handle, handle.style.cursor || 'move');
    handle.style.cursor = maximized ? 'pointer' : (originalCursor.get(handle) ?? 'move');
  }
}

/** Apply the cursor rule to every panel currently in the DOM. */
export function syncAllDragCursors(): void {
  for (const el of document.querySelectorAll<TogglePanel>('.jsPanel')) syncDragCursor(el);
}

/**
 * Start listening. Returns a stop function.
 *
 * The dblclick listener is on the capture phase so it sees the event before
 * anything inside a panel's content can stop propagation.
 */
export function startTitlebarBehavior(): () => void {
  const onDblclick = (e: Event): void => {
    let titlebar: HTMLElement | null = null;
    for (const node of e.composedPath()) {
      if (!(node instanceof HTMLElement)) continue;
      // Interactive contents come BEFORE the titlebar in the path, so this
      // bails out before we ever recognise a titlebar hit.
      if (node.matches(INTERACTIVE)) return;
      if (node.classList.contains('jsPanel-titlebar')) {
        titlebar = node;
        break;
      }
    }
    if (!titlebar) return;

    const panel = titlebar.closest('.jsPanel') as TogglePanel | null;
    if (!panel) return;
    if (panel.status === 'maximized' || panel.status === 'minimized') panel.normalize?.();
    else panel.maximize?.();
  };

  // The status events carry the panel id as `detail`; fall back to sweeping
  // every panel when it doesn't resolve to an element.
  const onStatusChange = (e: Event): void => {
    const id = (e as CustomEvent<string>).detail;
    const panel = (
      typeof id === 'string' ? document.getElementById(id) : null
    ) as TogglePanel | null;
    if (panel) syncDragCursor(panel);
    else syncAllDragCursors();
  };

  document.addEventListener('dblclick', onDblclick, true);
  document.addEventListener('jspanelstatuschange', onStatusChange);
  // A panel that boots straight into the maximized state (restored geometry)
  // still needs its cursor seeded, hence the load event too.
  document.addEventListener('jspanelloaded', onStatusChange);

  return () => {
    document.removeEventListener('dblclick', onDblclick, true);
    document.removeEventListener('jspanelstatuschange', onStatusChange);
    document.removeEventListener('jspanelloaded', onStatusChange);
  };
}
