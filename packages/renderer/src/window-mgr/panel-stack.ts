// packages/renderer/src/window-mgr/panel-stack.ts
//
// The content stack inside a panel: `[panes above][primary][panes below]`, with a
// drag splitter between each pane and the primary content.
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
// Not a Lit element on purpose. Its children are elements the window managers own
// and mount/unmount by hand (that is how minimize drops a grid's subscriptions),
// and a reactive template that re-renders its own children would fight that.

import { clampPaneSize, fitPanes, MIN_PANE_H, orderPanes } from './stack-math.js';

export interface StackPaneSpec {
  id: string;
  el: HTMLElement;
  edge: 'above' | 'below';
  /** Requested height in px; clamped against the container. */
  size: number;
  order: number;
  /** Called when a splitter drag ends, with the settled height. */
  onResized?: ((size: number) => void) | undefined;
}

interface Pane extends StackPaneSpec {
  wrap: HTMLElement;
  splitter: HTMLElement;
}

const SPLITTER_H = 5;

export interface PanelStack {
  /** The element to hand `createPanel` as its `content`. */
  readonly root: HTMLElement;
  /** Swap the primary child (the grid / view). Pass null to clear it. */
  setPrimary(el: HTMLElement | null): void;
  addPane(spec: StackPaneSpec): void;
  removePane(id: string): void;
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

  const innerHeight = (): number => root.clientHeight || 0;

  const otherPanesTotal = (exceptId: string): number => {
    let sum = 0;
    for (const p of panes.values()) if (p.id !== exceptId) sum += p.size + SPLITTER_H;
    return sum;
  };

  const applySizes = (): void => {
    for (const p of panes.values()) p.wrap.style.height = `${p.size}px`;
  };

  /** Re-order the DOM so pane `order` decides visual order on each edge. */
  const reflow = (): void => {
    for (const edge of ['above', 'below'] as const) {
      const host = edge === 'above' ? aboveHost : belowHost;
      const list = orderPanes([...panes.values()].filter((p) => p.edge === edge));
      for (const p of list) {
        // Above: pane then splitter (splitter sits against the primary).
        // Below: splitter then pane, for the same reason mirrored.
        if (edge === 'above') host.append(p.wrap, p.splitter);
        else host.append(p.splitter, p.wrap);
      }
    }
  };

  const refit = (): void => {
    const h = innerHeight();
    if (h <= 0 || panes.size === 0) return;
    const list = [...panes.values()];
    const splitters = list.length * SPLITTER_H;
    const fitted = fitPanes(
      list.map((p) => p.size),
      h - splitters,
    );
    list.forEach((p, i) => {
      p.size = fitted[i] ?? MIN_PANE_H;
    });
    applySizes();
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

  const makeSplitter = (pane: () => Pane): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'panel-stack-splitter';
    el.style.cssText = `flex:none;height:${SPLITTER_H}px;cursor:ns-resize;background:rgba(127,127,127,.28);touch-action:none`;
    el.setAttribute('role', 'separator');
    el.setAttribute('aria-orientation', 'horizontal');
    el.title = 'Drag to resize';

    el.addEventListener('pointerdown', (ev) => {
      const p = pane();
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      const startY = ev.clientY;
      const startSize = p.size;
      const move = (e: PointerEvent): void => {
        // Recomputed per move rather than captured: another pane may be resized
        // by its own ResizeObserver mid-drag.
        const dy = e.clientY - startY;
        const delta = p.edge === 'above' ? dy : -dy;
        p.size = clampPaneSize(startSize + delta, innerHeight() - panes.size * SPLITTER_H, otherPanesTotal(p.id));
        applySizes();
      };
      const up = (): void => {
        el.releasePointerCapture(ev.pointerId);
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        // Persist once, on release — not per pointermove, which would queue a
        // store write per pixel.
        p.onResized?.(p.size);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
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
      wrap.style.cssText = 'flex:none;min-height:0;overflow:hidden;display:flex;flex-direction:column';
      spec.el.style.flex = '1';
      spec.el.style.minHeight = '0';
      wrap.append(spec.el);

      const pane: Pane = { ...spec, wrap, splitter: document.createElement('div') };
      pane.splitter = makeSplitter(() => pane);
      pane.size = clampPaneSize(spec.size, innerHeight() - (panes.size + 1) * SPLITTER_H, otherPanesTotal(spec.id));
      panes.set(spec.id, pane);
      reflow();
      applySizes();
      startObserving();
      refit();
    },

    removePane(id) {
      const p = panes.get(id);
      if (!p) return;
      panes.delete(id);
      p.splitter.remove();
      // Removes the pane element with its wrapper, which is what drops the
      // element's `disconnectedCallback` — i.e. its subscriptions.
      p.wrap.remove();
      stopObserving();
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
      root.replaceChildren();
    },
  };
}
