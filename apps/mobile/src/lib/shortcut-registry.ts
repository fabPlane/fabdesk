/**
 * Who handles which shortcut. Screens register as they mount; the most recently registered
 * handler for a combo wins, so a screen pushed on top of another takes over its shortcuts and
 * hands them back when it goes. Combos are canonicalised on the way in, so the registry and the
 * native side agree on ids.
 */
import { normalizeCombo } from "./key-combo";

export type ShortcutHandler = () => void;

export interface ShortcutRegistry {
  /** Registers a handler; returns the function that removes it. `null` for an invalid combo. */
  register: (combo: string, handler: ShortcutHandler) => (() => void) | null;
  /** Runs the newest handler for the combo. Returns false when nothing is bound. */
  dispatch: (id: string) => boolean;
  /** Canonical ids with at least one handler, in first-registered order. */
  ids: () => string[];
}

export function createShortcutRegistry(onChange?: (ids: string[]) => void): ShortcutRegistry {
  const handlers = new Map<string, ShortcutHandler[]>();
  const ids = () => [...handlers.keys()];
  const changed = () => onChange?.(ids());

  return {
    register: (combo, handler) => {
      const id = normalizeCombo(combo);
      if (!id) return null;
      const list = handlers.get(id) ?? [];
      const isNew = list.length === 0;
      list.push(handler);
      handlers.set(id, list);
      if (isNew) changed();
      return () => {
        const current = handlers.get(id);
        if (!current) return;
        const i = current.lastIndexOf(handler);
        if (i >= 0) current.splice(i, 1);
        if (current.length === 0) {
          handlers.delete(id);
          changed();
        }
      };
    },
    dispatch: (id) => {
      const list = handlers.get(id);
      const handler = list?.[list.length - 1];
      if (!handler) return false;
      handler();
      return true;
    },
    ids,
  };
}
