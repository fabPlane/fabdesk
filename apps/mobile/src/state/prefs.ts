/** Device-local preferences from the Settings tab. Daemon-side settings go through `useSettings`. */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { jsonStorage } from "./storage";

export type Appearance = "system" | "light" | "dark";
export const APPEARANCES: readonly Appearance[] = ["system", "light", "dark"];

export interface PrefsState {
  appearance: Appearance;
  haptics: boolean;
  /** Keep the screen on while any run is live, so a long route or render can be watched. */
  keepAwake: boolean;
  /** Last local edit (unix ms); used for last-write-wins against the cloud copy. */
  updatedAt: number;
  setAppearance: (appearance: Appearance) => void;
  setHaptics: (on: boolean) => void;
  setKeepAwake: (on: boolean) => void;
  /** Apply a cloud document without bumping `updatedAt` (that stamp is the remote's). */
  applyCloud: (next: { appearance: Appearance; haptics: boolean; keepAwake: boolean; updatedAt: number }) => void;
}

/** True while `applyCloud` is writing, so the cloud push hook does not echo the pull. */
let applyingCloud = false;
export function isApplyingCloud(): boolean {
  return applyingCloud;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      appearance: "system",
      haptics: true,
      keepAwake: true,
      updatedAt: 0,
      setAppearance: (appearance) => set({ appearance, updatedAt: Date.now() }),
      setHaptics: (haptics) => set({ haptics, updatedAt: Date.now() }),
      setKeepAwake: (keepAwake) => set({ keepAwake, updatedAt: Date.now() }),
      applyCloud: (next) => {
        applyingCloud = true;
        try {
          set(next);
        } finally {
          applyingCloud = false;
        }
      },
    }),
    {
      name: "fabdesk.prefs",
      storage: jsonStorage(),
      partialize: ({ appearance, haptics, keepAwake, updatedAt }) => ({
        appearance,
        haptics,
        keepAwake,
        updatedAt,
      }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsState>;
        return {
          ...current,
          appearance: APPEARANCES.includes(p.appearance as Appearance)
            ? (p.appearance as Appearance)
            : current.appearance,
          haptics: typeof p.haptics === "boolean" ? p.haptics : current.haptics,
          keepAwake: typeof p.keepAwake === "boolean" ? p.keepAwake : current.keepAwake,
          updatedAt: typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : current.updatedAt,
        };
      },
    },
  ),
);
