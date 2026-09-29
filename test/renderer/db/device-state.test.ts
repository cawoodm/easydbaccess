import { describe, expect, it } from 'vitest';
import { FOLDER_OWNED_KEYS, mergeDeviceState, SEED_ONLY_INTO_NEW } from '../../../packages/renderer/src/db/edb/device-state.js';
import { SECRETS_KEY, USER_SETTINGS_KEY } from '../../../packages/renderer/src/db/user-settings.js';

/**
 * Adopting a folder moves state in BOTH directions, and getting either one
 * backwards loses something the user did not choose to lose.
 */
describe('mergeDeviceState', () => {
  const KEYS = ['a', 'b'];

  it('takes the folder over this browser', () => {
    // The whole point: a second machine reads the folder's answer, not whatever
    // it happened to have already.
    const r = mergeDeviceState({ a: 'folder' }, { a: 'browser' }, KEYS);
    expect(r.mirror.a).toBe('folder');
    expect(r.toLocal.a).toBe('folder');
    expect(r.seeded).toBe(false);
  });

  it('seeds the folder from this browser where the folder has nothing', () => {
    // The first connect after this ships: without it, a user who already had a
    // setup would be reset to defaults by the folder's silence.
    const r = mergeDeviceState({}, { a: 'browser' }, KEYS);
    expect(r.mirror.a).toBe('browser');
    expect(r.seeded).toBe(true);
    // Nothing to write back — the browser already holds it.
    expect(r.toLocal).toEqual({});
  });

  it('does not seed a key neither side holds', () => {
    const r = mergeDeviceState({}, { a: null }, KEYS);
    expect(r.mirror).toEqual({});
    expect(r.seeded).toBe(false);
  });

  it('mixes the two directions in one adopt', () => {
    const r = mergeDeviceState({ a: 'folder' }, { a: 'browser', b: 'mine' }, KEYS);
    expect(r.mirror).toEqual({ a: 'folder', b: 'mine' });
    expect(r.toLocal).toEqual({ a: 'folder' });
    expect(r.seeded).toBe(true);
  });

  it('carries a key the folder holds that is not in the owned list', () => {
    // A file written by a newer version knows about keys this one does not. They
    // are kept rather than dropped, so connecting with an older build and then a
    // newer one again does not silently empty them.
    const r = mergeDeviceState({ future: 'x' }, {}, KEYS);
    expect(r.mirror.future).toBe('x');
  });

  it('treats an empty string as a real value, not as absent', () => {
    // Clearing a setting is a decision. `?? null` on an empty string would read
    // it as "the folder said nothing" and seed the old value straight back.
    const r = mergeDeviceState({ a: '' }, { a: 'browser' }, KEYS);
    expect(r.mirror.a).toBe('');
    expect(r.seeded).toBe(false);
  });
});

describe('seeding a folder that is already somebody’s', () => {
  it('holds back a key on the never-seed list', () => {
    // A folder that already has a device file was set up elsewhere — a share, a
    // hand-over, a synced drive. Copying this machine's tokens into it is a
    // decision the user never made.
    const r = mergeDeviceState({ a: 'theirs' }, { a: 'mine', secret: 'token' }, ['a', 'secret'], { neverSeed: ['secret'] });
    expect(r.mirror.secret).toBeUndefined();
    expect(r.seeded).toBe(false);
  });

  it('still TAKES that key when the folder holds one', () => {
    // Withholding is about writing, not reading: a folder that carries a token
    // is the whole reason the feature exists.
    const r = mergeDeviceState({ secret: 'theirs' }, { secret: 'mine' }, ['secret'], { neverSeed: ['secret'] });
    expect(r.mirror.secret).toBe('theirs');
    expect(r.toLocal.secret).toBe('theirs');
  });

  it('seeds everything into a folder with no device file', () => {
    // The user's OWN folder, first connect: nothing is withheld, because there
    // is nobody else's setup to walk into.
    const r = mergeDeviceState({}, { a: 'mine', secret: 'token' }, ['a', 'secret']);
    expect(r.mirror).toEqual({ a: 'mine', secret: 'token' });
    expect(r.seeded).toBe(true);
  });

  it('withholds the secrets file and nothing else', () => {
    expect(SEED_ONLY_INTO_NEW).toEqual([SECRETS_KEY]);
  });
});

describe('FOLDER_OWNED_KEYS', () => {
  it('is the settings blob and the secrets file', () => {
    // Secrets are in here by an explicit decision — see the note on the const.
    // A change to this list is a change to what leaves the browser, so it is
    // spelled out rather than asserted by length.
    expect([...FOLDER_OWNED_KEYS].sort()).toEqual([SECRETS_KEY, USER_SETTINGS_KEY].sort());
  });
});
