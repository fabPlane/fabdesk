import { useEffect } from "react";
import { useSettings } from "./queries";
import { useUiStore } from "../stores/ui";

/** Legacy core-side preference (kept for the daemon's settings schema). */
export type ThemePreference = "system" | "light" | "dark";

/** Four explicit themes: the fabplane.com look in dark/light and the neutral "system" look in dark/light. */
export type ThemeId = "fabplane-dark" | "fabplane-light" | "plain-dark" | "plain-light";
export const THEME_IDS: readonly ThemeId[] = ["fabplane-dark", "fabplane-light", "plain-dark", "plain-light"];
export const THEME_LABELS: Record<ThemeId, string> = {
  "fabplane-dark": "Dark (fabPlane)",
  "fabplane-light": "Light (fabPlane)",
  "plain-dark": "System Dark",
  "plain-light": "System Light",
};

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

/** Maps the legacy `settings.theme` value (or nothing) to a theme id, following the OS for "system". */
export function themeFromPreference(pref: ThemePreference | undefined): ThemeId {
  const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = pref === "dark" || (pref !== "light" && prefersDark);
  return dark ? "fabplane-dark" : "fabplane-light";
}

export function applyThemeId(id: ThemeId): boolean {
  const dark = id.endsWith("-dark");
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.dataset["theme"] = dark ? "dark" : "light";
  root.dataset["skin"] = id.startsWith("plain") ? "plain" : "fabplane";
  return dark;
}

/** @deprecated use applyThemeId; kept for callers that still pass the legacy preference. */
export function applyTheme(pref: ThemePreference): boolean {
  return applyThemeId(themeFromPreference(pref));
}

/** Applies the persisted theme choice (Settings → Appearance) to the document; returns the active id. */
export function useTheme(): ThemeId {
  const settings = useSettings();
  const stored = useUiStore((s) => s.themeId);
  const id: ThemeId = stored ?? themeFromPreference(settings.data?.theme);
  useEffect(() => {
    applyThemeId(id);
  }, [id]);
  return id;
}

export function useIsDark(): boolean {
  return useTheme().endsWith("-dark");
}
