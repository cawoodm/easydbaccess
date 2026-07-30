/**
 * Pure status machine for the panel shell. jsPanel forgot the previous status
 * on minimize (see the deleted maximized-memory.ts); here `restoreStatus`
 * carries it, so leaving `minimized` lands where the user came from.
 */
export type PanelStatus = 'normalized' | 'minimized' | 'maximized' | 'smallified' | 'closed';
export type PanelAction = 'minimize' | 'maximize' | 'normalize' | 'smallify' | 'close';

export interface ShellState {
  status: PanelStatus;
  /** Where leaving `minimized` lands: maximized when the panel went down maximized. */
  restoreStatus: 'normalized' | 'maximized';
}

/** Boot state from stored WindowGeometry flags. minimized+maximized means:
 * the user minimized a maximized window last session. */
export function initialState(boot?: { minimized?: boolean; maximized?: boolean }): ShellState {
  if (boot?.minimized) {
    return { status: 'minimized', restoreStatus: boot.maximized ? 'maximized' : 'normalized' };
  }
  if (boot?.maximized) return { status: 'maximized', restoreStatus: 'normalized' };
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
 */
export function persistFlags(s: ShellState): { minimized: boolean; maximized: boolean } {
  return {
    minimized: s.status === 'minimized',
    maximized:
      s.status === 'maximized' || (s.status === 'minimized' && s.restoreStatus === 'maximized'),
  };
}
