/**
 * Core window manager for View windows.
 *
 * View windows are managed by the CORE, exactly like table windows are managed
 * by `jspanel-manager.ts` — window behaviour (drag/resize/maximize), geometry,
 * persistence, and boot-time restore are core responsibilities, NOT the `views`
 * plugin's. The plugin only owns data + intent: it seeds templates and the
 * dialog flips a `ViewInstance.open` flag. This manager reacts to that flag,
 * opening/closing the actual jsPanel windows and persisting their geometry.
 *
 * Mirrors the table window manager: a workspace-scoped subscription reconciles
 * live state (which instances are `open`) against the set of open panels, so a
 * window opens when its instance is flagged open and closes when the flag drops
 * or the instance is deleted. On boot, every instance already flagged `open`
 * gets its window re-created (jsPanel itself has no cross-reload memory).
 */

// @ts-expect-error — jspanel4 ships no types
import { jsPanel } from 'jspanel4/es6module/jspanel.js';
import type { ViewInstance, WindowGeometry } from '@easydb/shared';
import { getContext, type AppContext } from '../app-context.js';
import { currentPanZoom } from './jspanel-manager.js';
import { createMaximizeFill } from './maximize-fill.js';
// Side-effect import registers the <view-window> custom element; the type-only
// import would otherwise be elided, leaving <view-window> an unupgraded
// (inline, zero-size) element.
import '../views/view-window.js';
import type { ViewWindow } from '../views/view-window.js';

/** jsPanel instance — typed loose since the lib ships no .d.ts. */
type Panel = {
  id: string;
  close(): void;
  setHeaderTitle?: (title: string) => void;
  status: 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
};

const panels = new Map<string, { panel: Panel; el: ViewWindow }>();
let initialized = false;

/** Element view windows mount into — the pan/zoom-transformed canvas viewport. */
function viewContainer(): HTMLElement {
  return (
    document.getElementById('easydb-panels-viewport') ??
    document.getElementById('easydb-panels') ??
    document.body
  );
}

function cssSafe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function panelDomId(instanceId: string): string {
  return `view-panel-${cssSafe(instanceId)}`;
}

export async function initViewWindowManager(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const ctx = await getContext();

  const openInWs = (all: ViewInstance[]): ViewInstance[] =>
    all.filter((i) => i.workspaceId === ctx.workspaceId && i.open);

  // Initial restore: reopen every instance already flagged open.
  for (const inst of openInWs(await ctx.store.viewInstances.find())) openPanel(inst, ctx);

  // Reactive reconcile: open windows for newly-open instances, close windows
  // whose instance is no longer open (flag dropped) or was deleted.
  ctx.store.viewInstances.subscribe((all) => {
    const want = new Map(openInWs(all).map((i) => [i.id, i]));
    for (const id of [...panels.keys()]) if (!want.has(id)) closePanel(id);
    for (const [id, inst] of want) if (!panels.has(id)) openPanel(inst, ctx);
  });

  // Apply an instance edit (rename / re-mapping) to an already-open window
  // without tearing it down.
  document.addEventListener('easydb:reload-view', (e) => {
    const id = (e as CustomEvent<{ instanceId: string }>).detail?.instanceId;
    if (!id) return;
    const entry = panels.get(id);
    if (!entry) return;
    void (async () => {
      const inst = await ctx.store.viewInstances.findOne(id);
      if (inst) entry.panel.setHeaderTitle?.(inst.name);
      void entry.el.reload();
    })();
  });
}

function openPanel(inst: ViewInstance, ctx: AppContext): void {
  if (panels.has(inst.id)) return;
  const panelId = panelDomId(inst.id);

  const el = document.createElement('view-window') as ViewWindow;
  el.viewInstanceId = inst.id;
  el.style.height = '100%';

  const g = inst.windowGeometry;
  const sizeOpt = g ? { panelSize: `${g.w} ${g.h}` } : { contentSize: '480 520' };
  const position = g
    ? { my: 'left-top', at: 'left-top', offsetX: g.x, offsetY: g.y }
    : { my: 'center-top', at: 'center-top', offsetY: 60 };

  // Keep a maximized view filling the visible area through canvas pan/zoom —
  // the same counter-transform the table windows use (shared handle).
  const maxFill = createMaximizeFill(panelId, currentPanZoom);

  const panel = jsPanel.create({
    id: panelId,
    container: viewContainer(),
    headerTitle: inst.name,
    // A distinct cyan chrome so view windows read as different from tables.
    theme: '#0891b2',
    content: el,
    ...sizeOpt,
    position,
    minimizeTo: '#easydb-minimized-dock',
    dragit: { containment: false, stop: () => void saveGeometry(inst.id) },
    resizeit: { containment: false, stop: () => void saveGeometry(inst.id) },
    onstatuschange: (p: Panel) => {
      if (p.status === 'maximized') maxFill.enter();
      else maxFill.exit();
    },
    onclosed: () => {
      panels.delete(inst.id);
      maxFill.exit();
      // The user closed the window → drop the persisted open flag so it isn't
      // reopened on the next boot. (Closing because the flag already dropped is
      // a harmless redundant write; the reconcile subscription is idempotent.)
      void ctx.store.viewInstances
        .patch(inst.id, { open: false, updatedAt: Date.now() })
        .catch(() => {
          /* instance may have been deleted — ignore */
        });
    },
  }) as Panel;

  panels.set(inst.id, { panel, el });

  // Make the titlebar focusable so tapping it blurs (collapses) an open search
  // box — matches the table windows.
  const titlebar = document
    .getElementById(panelId)
    ?.querySelector('.jsPanel-titlebar') as HTMLElement | null;
  if (titlebar) {
    titlebar.tabIndex = -1;
    titlebar.style.outline = 'none';
    titlebar.addEventListener('pointerdown', () => titlebar.focus());
  }
}

function closePanel(instanceId: string): void {
  const entry = panels.get(instanceId);
  if (!entry) return;
  panels.delete(instanceId);
  try {
    if (entry.panel.status !== 'closed') entry.panel.close();
  } catch {
    /* already gone */
  }
}

async function saveGeometry(instanceId: string): Promise<void> {
  const el = document.getElementById(panelDomId(instanceId));
  const entry = panels.get(instanceId);
  if (!el || !entry) return;
  // Only the normalized rect is meaningful; while maximized/minimized jsPanel
  // parks the panel elsewhere, so keep the last-stored geometry.
  if (entry.panel.status !== 'normalized') return;
  const geom: WindowGeometry = {
    x: el.offsetLeft,
    y: el.offsetTop,
    w: el.offsetWidth,
    h: el.offsetHeight,
    z: 0,
    minimized: false,
    maximized: false,
  };
  try {
    const ctx = await getContext();
    await ctx.store.viewInstances.patch(instanceId, {
      windowGeometry: geom,
      updatedAt: Date.now(),
    });
  } catch {
    /* instance may have been deleted — ignore */
  }
}
