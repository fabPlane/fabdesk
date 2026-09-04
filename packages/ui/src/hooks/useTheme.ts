import { useEffect } from "react";
import {
  applyThemeIdTo,
  resolveThemeId,
  themeFromPreference as resolveFromPref,
  type ThemeId,
  type ThemePreference,
} from "../theme/resolve";
import { useSettings } from "./queries";
import { useUiStore } from "../stores/ui";

export type { ThemeId, ThemePreference } from "../theme/resolve";
export {
  THEME_IDS,
  THEME_LABELS,
  UI_THEME_STORAGE_KEY,
  applyThemeIdTo,
  bootstrapTheme,
  isThemeId,
  parsePersistedThemeId,
  resolveThemeId,
  themeBackground,
} from "../theme/resolve";

function prefersDarkScheme(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Maps the legacy `settings.theme` value (or nothing) to a theme id, following the OS for "system". */
export function themeFromPreference(pref: ThemePreference | undefined): ThemeId {
  return resolveFromPref(pref, prefersDarkScheme());
}

export function applyThemeId(id: ThemeId): boolean {
  return applyThemeIdTo(id, document.documentElement);
}

/** @deprecated use applyThemeId; kept for callers that still pass the legacy preference. */
export function applyTheme(pref: ThemePreference): boolean {
  return applyThemeId(themeFromPreference(pref));
}

/** Applies the persisted theme choice (Settings → Appearance) to the document; returns the active id. */
export function useTheme(): ThemeId {
  const settings = useSettings();
  const stored = useUiStore((s) => s.themeId);
  const id = resolveThemeId(stored, settings.data?.theme, prefersDarkScheme());
  useEffect(() => {
    applyThemeId(id);
  }, [id]);
  return id;
}

export function useIsDark(): boolean {
  return useTheme().endsWith("-dark");
}
