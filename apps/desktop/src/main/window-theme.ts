import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isThemeId,
  resolveThemeId,
  themeBackground,
  themeForeground,
  themeIsDark,
  themePanel,
  type ThemeId,
} from "../../../../packages/ui/src/theme/resolve";

/** Derived cache of the Appearance `themeId` so main can set `backgroundColor` before Chromium localStorage is readable. */
export const WINDOW_THEME_FILENAME = "theme.json";

export function windowThemePath(userData: string): string {
  return join(userData, WINDOW_THEME_FILENAME);
}

export function readCachedThemeId(userData: string): ThemeId | null {
  try {
    const raw = readFileSync(windowThemePath(userData), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const themeId = (parsed as { themeId?: unknown }).themeId;
    return isThemeId(themeId) ? themeId : null;
  } catch {
    return null;
  }
}

export function writeCachedThemeId(userData: string, themeId: ThemeId | null): void {
  mkdirSync(userData, { recursive: true });
  writeFileSync(windowThemePath(userData), `${JSON.stringify({ themeId })}\n`);
}

export interface WindowTheme {
  themeId: ThemeId;
  backgroundColor: string;
  themeSource: "system" | "light" | "dark";
}

/** Height of the top bar (`h-12` in TopBar.tsx); the Windows controls overlay matches it. */
export const TITLE_BAR_HEIGHT = 48;

/** Windows controls-overlay colours for a theme: the top bar's panel colour and its foreground. */
export function titleBarOverlayFor(themeId: ThemeId): { color: string; symbolColor: string; height: number } {
  return { color: themePanel(themeId), symbolColor: themeForeground(themeId), height: TITLE_BAR_HEIGHT };
}

/** Resolve the BrowserWindow background and nativeTheme source from the cached Appearance choice. */
export function resolveWindowTheme(userData: string, systemDark: boolean): WindowTheme {
  const cached = readCachedThemeId(userData);
  const themeId = resolveThemeId(cached, undefined, systemDark);
  return {
    themeId,
    backgroundColor: themeBackground(themeId),
    themeSource: cached ? (themeIsDark(themeId) ? "dark" : "light") : "system",
  };
}
