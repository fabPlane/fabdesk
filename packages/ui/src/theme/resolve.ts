/** Zustand persist key for `useUiStore` — the only theme preference the UI reads. */
export const UI_THEME_STORAGE_KEY = "fabdesk.ui";

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

/** First-paint backgrounds; keep in sync with `styles.css` `--fd-bg`. */
export const THEME_BACKGROUNDS: Record<ThemeId, string> = {
  "fabplane-dark": "#10130f",
  "fabplane-light": "#f1f0e9",
  "plain-dark": "#17161b",
  "plain-light": "#f7f7f8",
};

/** First-paint foregrounds; keep in sync with `styles.css` `--fd-fg`. */
export const THEME_FOREGROUNDS: Record<ThemeId, string> = {
  "fabplane-dark": "#edf0e9",
  "fabplane-light": "#1d211c",
  "plain-dark": "#ececf1",
  "plain-light": "#1a1a1f",
};

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === "string" && (THEME_IDS as readonly string[]).includes(v);
}

export function themeBackground(id: ThemeId): string {
  return THEME_BACKGROUNDS[id];
}

export function themeForeground(id: ThemeId): string {
  return THEME_FOREGROUNDS[id];
}

export function themeIsDark(id: ThemeId): boolean {
  return id.endsWith("-dark");
}

export function themeSkin(id: ThemeId): "plain" | "fabplane" {
  return id.startsWith("plain") ? "plain" : "fabplane";
}

/** Maps the legacy `settings.theme` value (or nothing) to a theme id. */
export function themeFromPreference(pref: ThemePreference | undefined, prefersDark: boolean): ThemeId {
  const dark = pref === "dark" || (pref !== "light" && prefersDark);
  return dark ? "fabplane-dark" : "fabplane-light";
}

/**
 * Resolve the theme shown before React mounts.
 * Stored Appearance choice wins; otherwise the core `theme` pref / OS.
 */
export function resolveThemeId(
  stored: ThemeId | null | undefined,
  pref: ThemePreference | undefined,
  prefersDark: boolean,
): ThemeId {
  if (isThemeId(stored)) return stored;
  return themeFromPreference(pref, prefersDark);
}

/** Read `themeId` out of the zustand persist payload for `fabdesk.ui`. */
export function parsePersistedThemeId(raw: string | null | undefined): ThemeId | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const state = (parsed as { state?: unknown }).state;
    if (!state || typeof state !== "object") return null;
    const themeId = (state as { themeId?: unknown }).themeId;
    return isThemeId(themeId) ? themeId : null;
  } catch {
    return null;
  }
}

export function readStoredThemeId(
  getItem: ((key: string) => string | null) | undefined = typeof localStorage === "undefined" ? undefined : (key) => localStorage.getItem(key),
): ThemeId | null {
  if (!getItem) return null;
  try {
    return parsePersistedThemeId(getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return null;
  }
}

export interface ThemeDocumentRoot {
  classList: { toggle: (token: string, force?: boolean) => unknown };
  dataset: { theme?: string; skin?: string };
  style: { colorScheme?: string; backgroundColor?: string };
}

/** Apply class / data-* / color-scheme / background so the first CSS paint matches `id`. */
export function applyThemeIdTo(id: ThemeId, root: ThemeDocumentRoot): boolean {
  const dark = themeIsDark(id);
  root.classList.toggle("dark", dark);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.skin = themeSkin(id);
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.backgroundColor = themeBackground(id);
  return dark;
}

export interface ThemeBootEnv {
  getItem: (key: string) => string | null;
  prefersDark: boolean;
}

/** Same resolution the inline `index.html` boot script runs before React. */
export function bootstrapTheme(env: ThemeBootEnv, root: ThemeDocumentRoot): ThemeId {
  const id = resolveThemeId(readStoredThemeId(env.getItem), undefined, env.prefersDark);
  applyThemeIdTo(id, root);
  return id;
}
