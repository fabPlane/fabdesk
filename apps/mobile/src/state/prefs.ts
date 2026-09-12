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
  setAppearance: (appearance: Appearance) => void;
  setHaptics: (on: boolean) => void;
  setKeepAwake: (on: boolean) => void;
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      appearance: "system",
      haptics: true,
      keepAwake: true,
      setAppearance: (appearance) => set({ appearance }),
      setHaptics: (haptics) => set({ haptics }),
      setKeepAwake: (keepAwake) => set({ keepAwake }),
    }),
    {
      name: "fabdesk.prefs",
      storage: jsonStorage(),
      partialize: ({ appearance, haptics, keepAwake }) => ({ appearance, haptics, keepAwake }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<PrefsState>;
        return {
          ...current,
          appearance: APPEARANCES.includes(p.appearance as Appearance)
            ? (p.appearance as Appearance)
            : current.appearance,
          haptics: typeof p.haptics === "boolean" ? p.haptics : current.haptics,
          keepAwake: typeof p.keepAwake === "boolean" ? p.keepAwake : current.keepAwake,
        };
      },
    },
  ),
);
