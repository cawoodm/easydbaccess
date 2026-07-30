import { describe, expect, it } from 'vitest';
import { initialState, persistFlags, transition } from './state.js';

describe('initialState', () => {
  it('defaults to normalized', () => {
    expect(initialState()).toEqual({ status: 'normalized', restoreStatus: 'normalized' });
  });
  it('boots minimized', () => {
    expect(initialState({ minimized: true })).toEqual({
      status: 'minimized',
      restoreStatus: 'normalized',
    });
  });
  it('boots minimized-was-maximized (stored minimized AND maximized)', () => {
    expect(initialState({ minimized: true, maximized: true })).toEqual({
      status: 'minimized',
      restoreStatus: 'maximized',
    });
  });
  it('boots maximized', () => {
    expect(initialState({ maximized: true }).status).toBe('maximized');
  });
});

describe('transition', () => {
  const norm = initialState();
  it('minimize remembers a maximized origin', () => {
    const max = transition(norm, 'maximize');
    const min = transition(max, 'minimize');
    expect(min).toEqual({ status: 'minimized', restoreStatus: 'maximized' });
    // The core fix for the open TODO: restore returns to maximized.
    expect(transition(min, 'normalize').status).toBe('maximized');
  });
  it('normalize from a plain minimize returns to normalized', () => {
    const min = transition(norm, 'minimize');
    expect(transition(min, 'normalize').status).toBe('normalized');
  });
  it('maximize clears the restore memory', () => {
    const s = transition(transition(norm, 'maximize'), 'maximize');
    expect(s.restoreStatus).toBe('normalized');
  });
  it('smallify only from normalized, normalize undoes it', () => {
    expect(transition(norm, 'smallify').status).toBe('smallified');
    expect(transition(transition(norm, 'maximize'), 'smallify').status).toBe('maximized');
    expect(transition(transition(norm, 'smallify'), 'normalize').status).toBe('normalized');
  });
  it('maximize from minimized works (Maximize All hits docked windows)', () => {
    const min = transition(norm, 'minimize');
    expect(transition(min, 'maximize').status).toBe('maximized');
  });
  it('closed is terminal', () => {
    const closed = transition(norm, 'close');
    expect(transition(closed, 'maximize').status).toBe('closed');
  });
});

describe('persistFlags', () => {
  it('matches the stored-flag contract of e2e 08', () => {
    const norm = initialState();
    expect(persistFlags(transition(norm, 'maximize'))).toEqual({
      minimized: false,
      maximized: true,
    });
    expect(persistFlags(transition(transition(norm, 'maximize'), 'minimize'))).toEqual({
      minimized: true,
      maximized: true,
    });
    expect(persistFlags(transition(norm, 'minimize'))).toEqual({
      minimized: true,
      maximized: false,
    });
    expect(persistFlags(norm)).toEqual({ minimized: false, maximized: false });
  });
});
