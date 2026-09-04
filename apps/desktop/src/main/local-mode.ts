/**
 * Local auth mode (no fabPlane login).
 *
 * The core only honours `--local-auth` on the public channel when a `.fabdesk-dev` marker exists in
 * its home directory (FABDESK_HOME or the per-platform config dir; see @fabdesk/auth-client/home).
 * `localAuthAllowed()` reports whether local mode is offered without a reveal: dev builds, or a
 * packaged build that already carries the marker. Switching local mode on writes the marker in any
 * build, so the undocumented Cmd+L / Ctrl+L reveal on the sign-in screen works in packaged builds too.
 */
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROD_CORE_HOME_DIR, resolveCoreHome } from "./dev-profile";

interface DesktopPrefs {
  localAuth?: boolean;
  /** Mirror of the core's `errorReporting` setting so Sentry is never initialized after an opt-out. */
  errorReporting?: boolean;
}

/**
 * Same rules as `fabdeskHome()` in @fabdesk/auth-client. The desktop main process sets
 * `FABDESK_HOME` to `fabdesk-dev` for the isolated unpackaged copy before this is read.
 */
export function coreHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return resolveCoreHome({ env, platform, dirName: PROD_CORE_HOME_DIR });
}

export function devMarkerPath(): string {
  return join(coreHome(), ".fabdesk-dev");
}

function prefsPath(): string {
  return join(app.getPath("userData"), "desktop-prefs.json");
}

export function readPrefs(): DesktopPrefs {
  try {
    return JSON.parse(readFileSync(prefsPath(), "utf8")) as DesktopPrefs;
  } catch {
    return {};
  }
}

export function writePrefs(patch: DesktopPrefs): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify({ ...readPrefs(), ...patch }, null, 2));
}

export function localAuthAllowed(): boolean {
  return !app.isPackaged || existsSync(devMarkerPath());
}

/** Local auth is on by default for the isolated Dev profile; production identity needs an opt-in. */
export function localAuthEnabled(defaultOn = !app.isPackaged): boolean {
  const enabled = readPrefs().localAuth ?? defaultOn;
  if (enabled) ensureDevMarker();
  return enabled;
}

/** Writes the marker the core checks, so `--local-auth` is not refused on the public channel. */
export function ensureDevMarker(): void {
  try {
    mkdirSync(coreHome(), { recursive: true });
    if (!existsSync(devMarkerPath())) writeFileSync(devMarkerPath(), `created by the fabdesk desktop app when local mode was enabled ${new Date().toISOString()}\n`);
  } catch {
    // best effort; the core will log the refusal
  }
}

export function setLocalAuth(enabled: boolean): void {
  writePrefs({ localAuth: enabled });
  if (enabled) ensureDevMarker();
}
