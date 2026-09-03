import { isMac } from "../util";

/** Subset of KeyboardEvent the reveal shortcut looks at (keeps the helper testable without a DOM). */
export interface RevealKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+L on macOS, Ctrl+L elsewhere: toggles the staging/local sign-in options on the login screen. */
export function isRevealDevOptionsShortcut(e: RevealKey, platform?: string): boolean {
  if (e.key.toLowerCase() !== "l" || e.altKey || e.shiftKey) return false;
  return isMac(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

/**
 * Staging password login and local mode are shown up front in dev builds, and otherwise only after
 * the reveal shortcut. The shortcut is deliberately not gated on the host allowing local auth: it is
 * an undocumented escape hatch that also works in a packaged build (the host then creates the
 * `.fabdesk-dev` marker the core checks when local mode is actually switched on).
 */
export function showDevSignInOptions(opts: { devBuild: boolean | undefined; revealed: boolean }): boolean {
  return opts.devBuild === true || opts.revealed;
}
