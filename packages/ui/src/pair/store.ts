/**
 * The saved computers as React state, backed by `localStorage`. One store for the pairing route,
 * the Computers list and the browser entry point, so pairing in one tab and switching in another
 * agree (a `storage` event re-reads the key).
 */
import { create } from "zustand";
import {
  SAVED_HOSTS_KEY,
  activeHost,
  readSavedHosts,
  withActive,
  withHost,
  withoutHost,
  writeSavedHosts,
  type SavedHost,
  type SavedHosts,
  type StorageLike,
} from "./hosts";

function storage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage access can throw (a blocked third-party context); the app then runs without memory.
    return null;
  }
}

interface SavedHostsState {
  saved: SavedHosts;
  add: (host: SavedHost) => void;
  remove: (host: string) => void;
  setActive: (host: string | null) => void;
  /** Re-reads storage; the entry point calls it once and on cross-tab changes. */
  reload: () => void;
  /** The Computers dialog, opened from wherever the shell puts its entry (UserFooter, Settings). */
  computersDialogOpen: boolean;
  setComputersDialogOpen: (open: boolean) => void;
}

export const useSavedHosts = create<SavedHostsState>()((set, get) => {
  const commit = (next: SavedHosts) => {
    const s = storage();
    if (s) writeSavedHosts(s, next);
    set({ saved: next });
  };
  return {
    saved: (() => {
      const s = storage();
      return s ? readSavedHosts(s) : { v: 1, active: null, hosts: [] };
    })(),
    add: (host) => commit(withHost(get().saved, host)),
    remove: (host) => commit(withoutHost(get().saved, host)),
    setActive: (host) => commit(withActive(get().saved, host)),
    reload: () => {
      const s = storage();
      if (s) set({ saved: readSavedHosts(s) });
    },
    computersDialogOpen: false,
    setComputersDialogOpen: (open) => set({ computersDialogOpen: open }),
  };
});

/** The computer the browser client should connect to at boot, or null. */
export function activeSavedHost(): SavedHost | null {
  return activeHost(useSavedHosts.getState().saved);
}

/** Subscribes to changes made in other tabs. Returns the unsubscribe. */
export function watchSavedHosts(): () => void {
  if (typeof window === "undefined") return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === SAVED_HOSTS_KEY) useSavedHosts.getState().reload();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
