/**
 * Pure status machine for the panel shell. jsPanel forgot the previous status
 * on minimize (see the deleted maximized-memory.ts); here `restoreStatus`
 * carries it, so leaving `minimized` lands where the user came from.
 */
export type PanelStatus = 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
export type PanelAction = 'minimize' | 'maximize' | 'normalize' | 'smallify' | 'close';

/**
 * Readonly on purpose: every status change goes through `transition`, which
 * returns a NEW state, and the shell reassigns its whole `state` variable. A
 * `state.status = …` written anywhere else would skip `applyStatusDom` and
 * `onstatuschange`, leaving the DOM and the store describing a status the panel
 * no longer has.
 */
export interface ShellState {
  readonly status: PanelStatus;
  /** Where leaving `minimized` lands: maximized when the panel went down maximized. */
  readonly restoreStatus: 'normalized' | 'maximized';
}

/** Boot state from stored WindowGeometry flags. minimized+maximized means:
 * the user minimized a maximized window last session. `smallified` is checked
 * last: it only ever applies to a panel that is otherwise normalized (the
 * transition below refuses to smallify anything else). */
export function initialState(boot?: {
  minimized?: boolean;
  maximized?: boolean;
  smallified?: boolean;
}): ShellState {
  if (boot?.minimized) {
    return { status: 'minimized', restoreStatus: boot.maximized ? 'maximized' : 'normalized' };
  }
  if (boot?.maximized) return { status: 'maximized', restoreStatus: 'normalized' };
  if (boot?.smallified) return { status: 'smallified', restoreStatus: 'normalized' };
  return { status: 'normalized', restoreStatus: 'normalized' };
}

export function transition(s: ShellState, a: PanelAction): ShellState {
  if (s.status === 'closed') return s;
  switch (a) {
    case 'close':
      return { ...s, status: 'closed' };
    case 'minimize':
      if (s.status === 'minimized') return s;
      return {
        status: 'minimized',
        restoreStatus: s.status === 'maximized' ? 'maximized' : 'normalized',
      };
    case 'maximize':
      return { status: 'maximized', restoreStatus: 'normalized' };
    case 'smallify':
      // Smallify is a normalized-only toggle; a parked or maximized panel keeps its state.
      if (s.status !== 'normalized') return s;
      return { ...s, status: 'smallified' };
    case 'normalize':
      if (s.status === 'minimized') return { status: s.restoreStatus, restoreStatus: 'normalized' };
      return { status: 'normalized', restoreStatus: 'normalized' };
  }
}

/**
 * The flags writeGeometry persists. A minimized-was-maximized panel keeps
 * maximized=true so a reload restores it maximized (e2e 08 asserts this).
 * `smallified` is exclusive with both: a panel can only collapse from
 * normalized, and minimizing or maximizing a collapsed one unfolds it.
 */
export function persistFlags(s: ShellState): {
  minimized: boolean;
  maximized: boolean;
  smallified: boolean;
} {
  return {
    minimized: s.status === 'minimized',
    maximized:
      s.status === 'maximized' || (s.status === 'minimized' && s.restoreStatus === 'maximized'),
    smallified: s.status === 'smallified',
  };
}
