import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { Principal } from "@fabdesk/protocol";

/**
 * fabPlane's per-user config/credentials directory. `FABDESK_HOME` wins; otherwise
 * `~/Library/Application Support/fabdesk` (macOS), `%APPDATA%\fabdesk` (Windows) or
 * `$XDG_CONFIG_HOME/fabdesk` (default `~/.config/fabdesk`).
 */
export function fabdeskHome(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const join = platform === "win32" ? win32.join : posix.join;
  const override = env["FABDESK_HOME"];
  if (override && override.trim() !== "") return override;
  const home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support", "fabdesk");
  if (platform === "win32") {
    const appData =
      env["APPDATA"] && env["APPDATA"] !== "" ? env["APPDATA"] : join(home, "AppData", "Roaming");
    return join(appData, "fabdesk");
  }
  const xdg =
    env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"] !== ""
      ? env["XDG_CONFIG_HOME"]
      : join(home, ".config");
  return join(xdg, "fabdesk");
}

/** Local (no-login) mode is only allowed off the public channel or with a `.fabdesk-dev` marker in FABDESK_HOME. */
export function localModeAllowed(opts: { channel: "public" | "internal"; home: string }): boolean {
  return opts.channel !== "public" || existsSync(join(opts.home, ".fabdesk-dev"));
}

export const LOCAL_PRINCIPAL: Principal = Object.freeze({
  subject: "local:dev",
  handle: "local",
  displayName: "Local developer",
});
