import type { AppEvents, EventBus, Unsubscribe } from '@easydb/shared';

type Listener<K extends keyof AppEvents> = (e: AppEvents[K]) => void;

export function createEventBus(): EventBus {
  const listeners = new Map<keyof AppEvents, Set<Listener<keyof AppEvents>>>();

  return {
    on<K extends keyof AppEvents>(name: K, fn: Listener<K>): Unsubscribe {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(fn as Listener<keyof AppEvents>);
      return () => {
        set!.delete(fn as Listener<keyof AppEvents>);
      };
    },
    emit<K extends keyof AppEvents>(name: K, payload: AppEvents[K]): void {
      const set = listeners.get(name);
      if (!set) return;
      for (const fn of set) {
        try {
          (fn as Listener<K>)(payload);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[event:${String(name)}] listener threw`, err);
        }
      }
    },
  };
}
