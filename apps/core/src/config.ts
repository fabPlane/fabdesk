/** Daemon configuration from env + compile-time defines. */
import { homedir } from "node:os";
import { join } from "node:path";
import { fabdeskHome as authHome } from "@fabdesk/auth-client";
import pkg from "../package.json" with { type: "json" };

declare const FABDESK_CHANNEL: string | undefined;

export const VERSION: string = pkg.version;

export type Channel = "public" | "internal";
export type AuthMode = "fabplane" | "local";

export function channel(): Channel {
  const compiled = typeof FABDESK_CHANNEL === "string" ? FABDESK_CHANNEL : undefined;
  const v = process.env["FABDESK_CHANNEL"] ?? compiled ?? "public";
  return v === "internal" ? "internal" : "public";
}

/** Per-platform config dir unless FABDESK_HOME is set (from @fabdesk/auth-client). */
export function fabdeskHome(): string {
  return authHome();
}

export function projectsDir(): string {
  return process.env["FABDESK_PROJECTS_DIR"] ?? join(homedir(), "fabdesk");
}

export function apiOrigin(): string {
  return process.env["FABPLANE_API_ORIGIN"] ?? "https://api.fabplane.com";
}

/** Where a locally started `@fp-pcb/bridge` listens by default. */
export const DEFAULT_FP_PCB_BRIDGE_URL = "http://127.0.0.1:4020";

/** `FABDESK_FP_PCB_BRIDGE_URL` > the `fpPcbBridgeUrl` setting > the default; trailing slash dropped. */
export function fpPcbBridgeUrl(
  settingUrl: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const v =
    env["FABDESK_FP_PCB_BRIDGE_URL"]?.trim() || settingUrl?.trim() || DEFAULT_FP_PCB_BRIDGE_URL;
  return v.replace(/\/+$/, "");
}

/** Where a locally started `@fab-cad/bridge` listens by default. */
export const DEFAULT_FAB_CAD_BRIDGE_URL = "http://127.0.0.1:4030";

/** `FABDESK_FAB_CAD_BRIDGE_URL` > the default; trailing slash dropped. */
export function fabCadBridgeUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env["FABDESK_FAB_CAD_BRIDGE_URL"]?.trim() || DEFAULT_FAB_CAD_BRIDGE_URL;
  return v.replace(/\/+$/, "");
}

/**
 * `FABDESK_FAB_CAD_BRIDGE_TOKEN`: the bearer the bridge expects (the desktop mints one per launch);
 * null when unset, and then nothing is sent — a bridge without auth needs none.
 */
export function fabCadBridgeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  return env["FABDESK_FAB_CAD_BRIDGE_TOKEN"]?.trim() || null;
}

export function authModeFromEnv(): AuthMode | undefined {
  const v = process.env["FABDESK_AUTH_MODE"];
  return v === "local" || v === "fabplane" ? v : undefined;
}

export function mintToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export type CoreConfig = {
  version: string;
  channel: Channel;
  home: string;
  projectsDir: string;
  dbPath: string;
  handshakePath: string;
  host: string;
  port: number;
  token: string;
  authMode: AuthMode;
  apiOrigin: string;
  parentPid: number | null;
  runtimeId: string | null;
};

export function resolveConfig(
  opts: {
    port?: number;
    host?: string;
    handshakeFile?: string;
    localAuth?: boolean;
    dataDir?: string;
    parentPid?: number;
  } = {},
): CoreConfig {
  const home = opts.dataDir ?? fabdeskHome();
  const envMode = authModeFromEnv();
  const authMode: AuthMode = opts.localAuth ? "local" : (envMode ?? "fabplane");
  return {
    version: VERSION,
    channel: channel(),
    home,
    projectsDir: projectsDir(),
    dbPath: join(home, "fabdesk.db"),
    handshakePath: opts.handshakeFile ?? join(home, "daemon.json"),
    host: opts.host ?? "127.0.0.1",
    port: opts.port ?? 0,
    token: process.env["FABDESK_TOKEN"] ?? mintToken(),
    authMode,
    apiOrigin: apiOrigin(),
    parentPid: opts.parentPid ?? null,
    runtimeId: process.env["FABDESK_RUNTIME_ID"]?.trim() || null,
  };
}
