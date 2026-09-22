// packages/renderer/src/window-mgr/panel-stack.ts
//
// The content stack inside a panel: `[rows above][primary][rows below]`, where a
// row is one or more docked panes side by side.
//
// `createPanel()` takes a SINGLE `content` element, so a window that wants a chart
// above its grid needs something to hold both. This is that something.
//
// **With no panes it renders its primary child and nothing else.** That is the
// property the whole design leans on: `table-window-manager.ts` runs every table
// window in the app through here, so an empty stack has to be behaviourally
// identical to passing the grid straight to `createPanel`. It adds one flex
// wrapper and no other DOM, no listeners and no layout of its own.
//
// **Two axes, two splitters.** A row's HEIGHT is dragged by the `ns-resize`
// splitter between it and the primary side (one per row, not one per pane —
// panes sharing a row share its height). A pane's WIDTH is dragged by the
// `ew-resize` splitter between it and its neighbour, which moves weight between
// those two panes only. The arithmetic for both is in `stack-math.ts`, pure, so
// the decisions a pointer drag makes are testable without a pointer.
//
// Not a Lit element on purpose. Its children are elements the window managers own
// and mount/unmount by hand (that is how minimize drops a grid's subscriptions),
// and a reactive template that re-renders its own children would fight that.

import { applyChildPlan, planChildren } from './child-plan.js';
import { clampPaneSize, fitPanes, MIN_PANE_H, paneRows, resizedRowWeights, rowOf, rowWeights } from './stack-math.js';

export interface StackPaneSpec {
  id: string;
  el: HTMLElement;
  edge: 'above' | 'below';
  /** Requested height of this pane's ROW in px; clamped against the container. */
  size: number;
  /** Left-to-right position within its row, ascending. */
  order: number;
  /** Which row of the edge. Absent ⇒ `order`, i.e. a row of its own. */
  row?: number | undefined;
  /** Share of the row's width. Absent ⇒ an equal share. */
  weight?: number | undefined;
  /** Called when a height drag ends, with the settled row height. */
  onResized?: ((size: number) => void) | undefined;
  /** Called when a width drag ends, with this pane's settled weight. */
  onWeighted?: ((weight: number) => void) | undefined;
}

interface Pane extends StackPaneSpec {
  wrap: HTMLElement;
  /**
   * Height the pane is pinned to while collapsed (its header strip), or null
   * when it is open. `size` keeps the user's chosen height throughout, so
   * expanding restores it.
   */
  collapsed: number | null;
}

const SPLITTER_H = 5;
const SPLITTER_W = 5;

export interface PanelStack {
  /** The element to hand `createPanel` as its `content`. */
  readonly root: HTMLElement;
  /** Swap the primary child (the grid / view). Pass null to clear it. */
  setPrimary(el: HTMLElement | null): void;
  addPane(spec: StackPaneSpec): void;
  /**
   * Re-place a pane that is already mounted.
   *
   * What a move needs: `row`, `order` and `weight` all come from the store, and a
   * pane joining another row must not be removed and re-added to pick them up —
   * that unmounts its element, and unmounting a viz drops its row subscription
   * and makes it re-read and redraw for a change of position. Returns false when
   * nothing about the placement actually differs, so the caller can skip a
   * reflow it does not need.
   */
  updatePane(id: string, placement: Pick<StackPaneSpec, 'edge' | 'size' | 'order' | 'row' | 'weight'>): boolean;
  removePane(id: string): void;
  /**
   * Pin a pane to `height` px and hide its splitter, or pass null to give it
   * its own height back. This is what makes a collapse give the room to the
   * primary content instead of leaving an empty box behind.
   */
  setPaneCollapsed(id: string, height: number | null): void;
  hasPane(id: string): boolean;
  paneIds(): string[];
  /** Re-apply sizes to the current container height. */
  refit(): void;
  destroy(): void;
}

export function createPanelStack(): PanelStack {
  const root = document.createElement('div');
  root.className = 'panel-stack';
  root.style.cssText = 'display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden';

  const aboveHost = document.createElement('div');
  aboveHost.className = 'panel-stack-above';
  aboveHost.style.cssText = 'display:flex;flex-direction:column;flex:none;min-height:0';

  const primaryHost = document.createElement('div');
  primaryHost.className = 'panel-stack-primary';
  // `min-height:0` is load-bearing: without it a flex child refuses to shrink
  // below its content height and the grid pushes the panes out of the window.
  primaryHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden';

  const belowHost = document.createElement('div');
  belowHost.className = 'panel-stack-below';
  belowHost.style.cssText = 'display:flex;flex-direction:column;flex:none;min-height:0';

  root.append(aboveHost, primaryHost, belowHost);

  const panes = new Map<string, Pane>();
  let ro: ResizeObserver | null = null;

  /**
   * Row elements and splitters, kept alive across reflows and keyed by SLOT
   * (`edge:rowIndex`, plus the boundary index for a width splitter).
   *
   * Reused rather than rebuilt so that a reflow which changes nothing about a
   * row leaves its element — and therefore its panes — untouched in the DOM. A
   * splitter identified by its slot can be reused across a membership change
   * because it resolves the row it acts on when the drag STARTS, not when it was
   * built.
   */
  const rowEls = new Map<string, HTMLElement>();
  const heightSplitters = new Map<string, HTMLElement>();
  const widthSplitters = new Map<string, HTMLElement>();

  const innerHeight = (): number => root.clientHeight || 0;

  /** Panes of one edge, grouped into rows — the unit both axes are laid out in. */
  const rowsOf = (edge: 'above' | 'below'): Pane[][] => paneRows([...panes.values()].filter((p) => p.edge === edge));

  /** The row in a given slot right now, or empty if that slot no longer exists. */
  const rowAt = (edge: 'above' | 'below', index: number): Pane[] => rowsOf(edge)[index] ?? [];

  /** Every row of both edges, which is what the height arithmetic runs over. */
  const allRows = (): Pane[][] => [...rowsOf('above'), ...rowsOf('below')];

  /**
   * What a row occupies.
   *
   * The tallest pane in it, because panes in one row share its height and they
   * can disagree — a pane that has just moved in brings the height of the row it
   * left. A row is collapsed only when EVERY pane in it is, so one collapsed
   * chart beside an open one does not shrink the pair.
   */
  const rowHeight = (row: readonly Pane[]): number => {
    const open = row.filter((p) => p.collapsed === null);
    if (open.length === 0) return Math.max(...row.map((p) => p.collapsed ?? 0), 0);
    return Math.max(...open.map((p) => p.size));
  };

  const rowCollapsed = (row: readonly Pane[]): boolean => row.every((p) => p.collapsed !== null);

  /** A fully collapsed row's splitter is hidden, so it costs nothing either. */
  const rowSplitterHeight = (row: readonly Pane[]): boolean => !rowCollapsed(row);

  const splittersTotal = (): number => allRows().filter(rowSplitterHeight).length * SPLITTER_H;

  /**
   * What every row OTHER than this one takes, which is what a height drag is
   * clamped against.
   *
   * Compared by PANE identity, not by row identity: `allRows()` groups afresh on
   * every call, so the array a splitter captured is never the same object as the
   * one that comes back — and a reference check therefore counted the dragged
   * row against itself, leaving it almost no room to grow into.
   */
  const otherRowsTotal = (except: readonly Pane[]): number => {
    let sum = 0;
    for (const row of allRows()) {
      if (row.some((p) => except.includes(p))) continue;
      sum += rowHeight(row) + (rowSplitterHeight(row) ? SPLITTER_H : 0);
    }
    return sum;
  };

  /**
   * Push the model onto the DOM: row heights, pane weights, splitter visibility.
   *
   * The wanted shape is computed from `panes` every time, but it is RECONCILED
   * onto the DOM rather than rebuilt — see `child-plan.ts`. Re-appending every
   * pane was correct and cheap and still wrong: moving a wrapper detaches the
   * pane inside it, a detached visualization destroys its Leaflet or Chart.js
   * instance, and nothing then asks for it back. So docking a second chart
   * beside a map has to leave the map's wrapper exactly where it is.
   */
  const reflow = (): void => {
    for (const edge of ['above', 'below'] as const) {
      const host = edge === 'above' ? aboveHost : belowHost;
      const rows = rowsOf(edge);
      const wanted: HTMLElement[] = [];
      rows.forEach((row, index) => {
        const rowEl = rowElement(edge, index);
        const weights = rowWeights(row);
        const inner: HTMLElement[] = [];
        row.forEach((p, i) => {
          if (i > 0) inner.push(widthSplitter(edge, index, i - 1));
          p.wrap.style.flex = `${weights[i] ?? 1 / row.length} 1 0`;
          inner.push(p.wrap);
        });
        applyChildPlan(rowEl, planChildren([...rowEl.children], inner));
        rowEl.style.height = `${rowHeight(row)}px`;
        const splitter = heightSplitter(edge, index);
        // A fully collapsed row's splitter is hidden, and the slot may have held
        // a collapsed row last time — so this is set both ways, not just off.
        splitter.style.display = rowCollapsed(row) ? 'none' : '';
        // Above: row then splitter (the splitter sits against the primary).
        // Below: splitter then row, for the same reason mirrored.
        if (edge === 'above') wanted.push(rowEl, splitter);
        else wanted.push(splitter, rowEl);
      });
      applyChildPlan(host, planChildren([...host.children], wanted));
      dropSlotsBeyond(edge, rows);
    }
  };

  /** The element for one row slot, created on first use and then reused. */
  const rowElement = (edge: 'above' | 'below', index: number): HTMLElement => {
    const key = `${edge}:${index}`;
    const cached = rowEls.get(key);
    if (cached) return cached;
    const el = document.createElement('div');
    el.className = 'panel-stack-row';
    el.style.cssText = 'display:flex;flex-direction:row;flex:none;min-height:0;min-width:0;overflow:hidden';
    rowEls.set(key, el);
    return el;
  };

  /**
   * Forget the slots an edge no longer has.
   *
   * Only housekeeping — a cached element for a slot that comes back would be
   * reused correctly — but an edge that briefly held six rows should not keep
   * six row elements and their listeners alive for the rest of the window's life.
   */
  const dropSlotsBeyond = (edge: 'above' | 'below', rows: readonly Pane[][]): void => {
    for (const map of [rowEls, heightSplitters, widthSplitters]) {
      for (const key of [...map.keys()]) {
        const [keyEdge, index] = key.split(':');
        if (keyEdge !== edge) continue;
        if (Number(index) >= rows.length) map.delete(key);
      }
    }
  };

  /** Heights only — the cheap pass a drag can run per pointermove. */
  const applyHeights = (): void => {
    for (const edge of ['above', 'below'] as const) {
      const host = edge === 'above' ? aboveHost : belowHost;
      const rows = rowsOf(edge);
      const rowEls = [...host.querySelectorAll<HTMLElement>(':scope > .panel-stack-row')];
      rows.forEach((row, i) => {
        const el = rowEls[i];
        if (el) el.style.height = `${rowHeight(row)}px`;
      });
    }
  };

  const refit = (): void => {
    const h = innerHeight();
    if (h <= 0 || panes.size === 0) return;
    const rows = allRows();
    // A collapsed row is a fixed cost, not something to shrink further — it is
    // already at its floor, and putting it through `fitPanes` would push it back
    // up to MIN_PANE_H.
    const fixed = rows.reduce((sum, row) => sum + (rowSplitterHeight(row) ? SPLITTER_H : 0) + (rowCollapsed(row) ? rowHeight(row) : 0), 0);
    const open = rows.filter((row) => !rowCollapsed(row));
    if (open.length > 0) {
      const fitted = fitPanes(
        open.map((row) => rowHeight(row)),
        h - fixed,
      );
      open.forEach((row, i) => {
        const next = fitted[i] ?? MIN_PANE_H;
        // Onto every pane in the row: `size` is the row's height, so the panes
        // sharing it have to agree or the next `rowHeight` picks the stale one.
        for (const p of row) p.size = next;
      });
    }
    applyHeights();
  };

  const startObserving = (): void => {
    if (ro || panes.size === 0) return;
    // A maximize, a browser resize, or a header wrap all change the stack's
    // height without any drag — the panes have to give room back.
    ro = new ResizeObserver(() => refit());
    ro.observe(root);
  };

  const stopObserving = (): void => {
    if (panes.size > 0) return;
    ro?.disconnect();
    ro = null;
  };

  /**
   * The `ns-resize` handle that sets a ROW's height, one per row slot.
   *
   * The row it acts on is resolved on `pointerdown`, not captured when the
   * element is built: the handle belongs to the slot, and the panes in that slot
   * change as they move between rows. Resolving it late is also what lets the
   * element be reused across a reflow, which is what keeps the panes around it
   * from being re-inserted.
   */
  const heightSplitter = (edge: 'above' | 'below', index: number): HTMLElement => {
    const key = `${edge}:${index}`;
    const cached = heightSplitters.get(key);
    if (cached) return cached;
    const el = document.createElement('div');
    el.className = 'panel-stack-splitter';
    el.style.cssText = `flex:none;height:${SPLITTER_H}px;cursor:ns-resize;background:rgba(127,127,127,.28);touch-action:none`;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'horizontal');
    el.title = 'Drag to resize';

    el.addEventListener('pointerdown', (ev) => {
      const row = rowAt(edge, index);
      if (row.length === 0) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      const startY = ev.clientY;
      const startSize = rowHeight(row);
      const move = (e: PointerEvent): void => {
        // Recomputed per move rather than captured: another row may be resized
        // by its own ResizeObserver mid-drag.
        const dy = e.clientY - startY;
        const delta = edge === 'above' ? dy : -dy;
        const next = clampPaneSize(startSize + delta, innerHeight() - splittersTotal(), otherRowsTotal(row));
        for (const p of row) p.size = next;
        applyHeights();
      };
      const up = (): void => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        // Persist once, on release — not per pointermove, which would queue a
        // store write per pixel. Every pane in the row, because the height is
        // the row's and each pane records its own copy of it.
        for (const p of row) p.onResized?.(p.size);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    heightSplitters.set(key, el);
    return el;
  };

  /**
   * The `ew-resize` handle between pane `i` and `i + 1` of a row slot.
   *
   * It moves weight between those TWO panes and nothing else. Taking it from the
   * row as a whole would shuffle a pane three columns away under a drag aimed at
   * one boundary, which reads as the layout coming apart.
   *
   * Slot-keyed and late-resolved for the same reason as the height handle above.
   */
  const widthSplitter = (edge: 'above' | 'below', index: number, i: number): HTMLElement => {
    const key = `${edge}:${index}:${i}`;
    const cached = widthSplitters.get(key);
    if (cached) return cached;
    const el = document.createElement('div');
    el.className = 'panel-stack-vsplitter';
    el.style.cssText = `flex:none;width:${SPLITTER_W}px;cursor:ew-resize;background:rgba(127,127,127,.28);touch-action:none`;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'vertical');
    el.title = 'Drag to resize';

    el.addEventListener('pointerdown', (ev) => {
      const row = rowAt(edge, index);
      const left = row[i];
      const right = row[i + 1];
      if (!left || !right) return;
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      const startX = ev.clientX;
      const weights = rowWeights(row);
      const startLeft = weights[i] ?? 0;
      const startRight = weights[i + 1] ?? 0;
      const width = el.parentElement?.clientWidth ?? 0;
      const move = (e: PointerEvent): void => {
        const [nextLeft, nextRight] = resizedRowWeights(startLeft, startRight, e.clientX - startX, width);
        left.weight = nextLeft;
        right.weight = nextRight;
        // Only the pair moves, so only the pair's flex is rewritten. The rest of
        // the row keeps whatever share it had.
        left.wrap.style.flex = `${nextLeft} 1 0`;
        right.wrap.style.flex = `${nextRight} 1 0`;
      };
      const up = (): void => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        // The whole row, not just the pair: a pane that had no weight of its own
        // was drawing an equal share, and that share is now a fact about the row
        // rather than a default. Leaving it absent would make it re-divide the
        // moment a neighbour is dragged again.
        const settled = rowWeights(row);
        row.forEach((p, n) => {
          p.weight = settled[n] ?? p.weight;
          if (p.weight !== undefined) p.onWeighted?.(p.weight);
        });
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
    widthSplitters.set(key, el);
    return el;
  };

  return {
    root,

    setPrimary(el) {
      primaryHost.replaceChildren();
      if (el) {
        // The primary child fills the host; a grid sets its own height:100% but a
        // view window may not, so the host does the work either way.
        el.style.flex = '1';
        el.style.minHeight = '0';
        primaryHost.append(el);
      }
    },

    addPane(spec) {
      if (panes.has(spec.id)) this.removePane(spec.id);
      const wrap = document.createElement('div');
      wrap.className = 'panel-stack-pane';
      // `min-width:0` for the same reason `min-height:0` is on the primary: a
      // flex child otherwise refuses to shrink below its content width, and one
      // wide chart would push its neighbour out of the row.
      wrap.style.cssText = 'min-height:0;min-width:0;overflow:hidden;display:flex;flex-direction:column';
      spec.el.style.flex = '1';
      spec.el.style.minHeight = '0';
      wrap.append(spec.el);

      const pane: Pane = { ...spec, wrap, collapsed: null };
      // Against the rows that already exist, plus the splitter this one adds.
      pane.size = clampPaneSize(spec.size, innerHeight() - splittersTotal() - SPLITTER_H, otherRowsTotal([]));
      panes.set(spec.id, pane);
      // A pane joining an existing row takes that row's height, since the height
      // belongs to the row. Without this the row would jump to whatever the
      // newcomer last had.
      const mine = rowsOf(spec.edge).find((row) => row.includes(pane));
      if (mine && mine.length > 1) pane.size = Math.max(...mine.filter((p) => p !== pane && p.collapsed === null).map((p) => p.size), MIN_PANE_H);
      reflow();
      startObserving();
      refit();
    },

    updatePane(id, placement) {
      const p = panes.get(id);
      if (!p) return false;
      if (p.edge === placement.edge && p.order === placement.order && p.row === placement.row && p.weight === placement.weight && p.size === placement.size) return false;
      p.edge = placement.edge;
      p.order = placement.order;
      p.row = placement.row;
      p.weight = placement.weight;
      p.size = placement.size;
      reflow();
      refit();
      return true;
    },

    removePane(id) {
      const p = panes.get(id);
      if (!p) return;
      panes.delete(id);
      // Removes the pane element with its wrapper, which is what drops the
      // element's `disconnectedCallback` — i.e. its subscriptions.
      p.wrap.remove();
      reflow();
      stopObserving();
      refit();
    },

    setPaneCollapsed(id, height) {
      const p = panes.get(id);
      if (!p) return;
      const next = height === null ? null : Math.max(0, Math.round(height));
      if (p.collapsed === next) return;
      p.collapsed = next;
      // Reflow, not just heights: a row whose every pane is now collapsed hides
      // its splitter, which is a DOM change rather than a size.
      reflow();
      refit();
    },

    hasPane(id) {
      return panes.has(id);
    },

    paneIds() {
      return [...panes.keys()];
    },

    refit,

    destroy() {
      ro?.disconnect();
      ro = null;
      panes.clear();
      rowEls.clear();
      heightSplitters.clear();
      widthSplitters.clear();
      root.replaceChildren();
    },
  };
}

/** Re-export so callers laying out panes do not need two imports. */
export { rowOf };
