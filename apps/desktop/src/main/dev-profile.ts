/**
 * Isolated "Fabdesk Dev" identity so an unpackaged `bun run dev` copy can run next to the
 * installed production app (VS Code vs Insiders). Electron's single-instance lock and default
 * userData both key off the app name, so this must run before `getPath('userData')` and
 * `requestSingleInstanceLock()`.
 *
 * Default: unpackaged = dev profile. `FABDESK_DEV_PROFILE=1` forces it on a packaged nightly;
 * `FABDESK_DEV_PROFILE=0` forces the production identity (useful for side-by-side tests).
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const PROD_PRODUCT_NAME = "Fabdesk";
export const DEV_PRODUCT_NAME = "Fabdesk Dev";
export const PROD_APP_USER_MODEL_ID = "com.tensorfleet.fabdesk";
export const DEV_APP_USER_MODEL_ID = "com.tensorfleet.fabdesk.dev";
export const PROD_DESKTOP_NAME = "fabdesk.desktop";
export const DEV_DESKTOP_NAME = "fabdesk-dev.desktop";
export const PROD_LINUX_WM_CLASS = "Fabdesk";
export const DEV_LINUX_WM_CLASS = "fabdesk-dev";
export const PROD_CORE_HOME_DIR = "fabdesk";
export const DEV_CORE_HOME_DIR = "fabdesk-dev";
/** Fixed loopback port for a dev-profile core so MCP configs survive `bun --watch` reloads. */
export const DEFAULT_DEV_CORE_PORT = "47831";

export type DesktopIdentity = {
  devProfile: boolean;
  productName: string;
  appUserModelId: string;
  desktopName: string;
  linuxWmClass: string;
  coreHomeDirName: string;
  defaultCorePort: string;
};

export type IdentityApp = {
  setName(name: string): void;
  getPath(name: "appData" | "userData"): string;
  setPath(name: "userData", path: string): void;
  setAppUserModelId(id: string): void;
  setDesktopName?(name: string): void;
  commandLine: { appendSwitch(key: string, value?: string): void };
};

export function parseDevProfileFlag(value: string | undefined): boolean | undefined {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

/** Unpackaged builds are the default "dev copy"; the env flag overrides either way. */
export function useDevProfile(opts: { packaged: boolean; env?: NodeJS.ProcessEnv }): boolean {
  const flag = parseDevProfileFlag(opts.env?.["FABDESK_DEV_PROFILE"]);
  if (flag !== undefined) return flag;
  return !opts.packaged;
}

export function desktopIdentity(devProfile: boolean): DesktopIdentity {
  if (devProfile) {
    return {
      devProfile: true,
      productName: DEV_PRODUCT_NAME,
      appUserModelId: DEV_APP_USER_MODEL_ID,
      desktopName: DEV_DESKTOP_NAME,
      linuxWmClass: DEV_LINUX_WM_CLASS,
      coreHomeDirName: DEV_CORE_HOME_DIR,
      defaultCorePort: DEFAULT_DEV_CORE_PORT,
    };
  }
  return {
    devProfile: false,
    productName: PROD_PRODUCT_NAME,
    appUserModelId: PROD_APP_USER_MODEL_ID,
    desktopName: PROD_DESKTOP_NAME,
    linuxWmClass: PROD_LINUX_WM_CLASS,
    coreHomeDirName: PROD_CORE_HOME_DIR,
    defaultCorePort: DEFAULT_DEV_CORE_PORT,
  };
}

/** Parent of Electron `userData` and of `FABDESK_HOME` (same rules as `@fabdesk/auth-client`). */
export function platformAppDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = env["HOME"] && env["HOME"] !== "" ? env["HOME"] : homedir();
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") {
    const appData = env["APPDATA"] && env["APPDATA"] !== "" ? env["APPDATA"] : join(home, "AppData", "Roaming");
    return appData;
  }
  const xdg = env["XDG_CONFIG_HOME"] && env["XDG_CONFIG_HOME"] !== "" ? env["XDG_CONFIG_HOME"] : join(home, ".config");
  return xdg;
}

export function resolveUserDataPath(opts: {
  productName: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}): string {
  return join(platformAppDataDir(opts.env ?? {}, opts.platform ?? "linux"), opts.productName);
}

export function resolveCoreHome(opts: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  dirName: string;
}): string {
  const env = opts.env ?? {};
  const override = env["FABDESK_HOME"];
  if (override && override.trim() !== "") return override;
  return join(platformAppDataDir(env, opts.platform ?? "linux"), opts.dirName);
}

export function resolveDevCorePort(env: NodeJS.ProcessEnv = {}): string {
  return env["FABDESK_DEV_PORT"] ?? DEFAULT_DEV_CORE_PORT;
}

/**
 * Packaged production (and a binary override) bind a random port. The isolated dev copy uses a
 * fixed port so MCP configs and the renderer survive core reloads.
 */
export function spawnCorePort(opts: {
  packaged: boolean;
  binaryOverride?: boolean;
  devProfile: boolean;
  env?: NodeJS.ProcessEnv;
}): string {
  if (opts.binaryOverride) return "0";
  if (opts.devProfile) return resolveDevCorePort(opts.env);
  return "0";
}

/** Apply name / userData / AUMID / WM_CLASS / FABDESK_HOME. No-op for the production identity. */
export function applyDesktopIdentity(
  app: IdentityApp,
  opts: { packaged: boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform },
): DesktopIdentity {
  const identity = desktopIdentity(useDevProfile(opts));
  if (!identity.devProfile) return identity;

  app.setName(identity.productName);
  app.setPath("userData", join(app.getPath("appData"), identity.productName));
  app.setAppUserModelId(identity.appUserModelId);
  if (opts.platform === "linux") {
    app.setDesktopName?.(identity.desktopName);
    app.commandLine.appendSwitch("class", identity.linuxWmClass);
  }
  if (!opts.env["FABDESK_HOME"] || opts.env["FABDESK_HOME"].trim() === "") {
    opts.env["FABDESK_HOME"] = resolveCoreHome({
      env: opts.env,
      platform: opts.platform,
      dirName: identity.coreHomeDirName,
    });
  }
  return identity;
}
