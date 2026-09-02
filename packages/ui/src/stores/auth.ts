import type { AuthState } from "@fabdesk/protocol";
import { create } from "zustand";

export interface AuthStoreState {
  state: AuthState | null;
  localAllowed: boolean;
  setState: (state: AuthState) => void;
  setLocalAllowed: (allowed: boolean) => void;
}

export const useAuthStore = create<AuthStoreState>()((set) => ({
  state: null,
  localAllowed: false,
  setState: (state) => set({ state }),
  setLocalAllowed: (localAllowed) => set({ localAllowed }),
}));
