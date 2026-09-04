/**
 * Client for the desktop app automation bridge (apps/desktop/src/main/automation.ts). The Electron
 * main process writes `app-bridge.json` next to the daemon handshake file; every call re-reads it so
 * an app restart (new port) is picked up without restarting the core. Bearer = the daemon token the
 * app handed us in FABDESK_TOKEN, so only this core (and holders of its token) can drive the window.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ToolError, type AppBridge, type AppBridgeStatus } from "@fabdesk/tools";

export const APP_BRIDGE_FILE = "app-bridge.json";

export type AppBridgeFile = { url: string; pid: number; startedAt: string };

export type AppBridgeClientOptions = {
  /** Path of app-bridge.json. */
  file: string;
  /** Bearer token (the daemon token). */
  token: string;
  fetch?: typeof fetch;
  /** Liveness probe for the pid in the file; default `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean;
  timeoutMs?: number;
};

/** `FABDESK_APP_BRIDGE_FILE` or `<dir of daemon.json>/app-bridge.json`. */
export function locateAppBridgeFile(handshakePath: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env["FABDESK_APP_BRIDGE_FILE"];
  if (override && override.trim() !== "") return override;
  return join(dirname(handshakePath), APP_BRIDGE_FILE);
}

export function parseAppBridgeFile(text: string): AppBridgeFile | null {
  try {
    const v = JSON.parse(text) as Partial<AppBridgeFile>;
    if (!v || typeof v.url !== "string" || typeof v.pid !== "number") return null;
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+\/?$/.test(v.url)) return null;
    return { url: v.url.replace(/\/$/, ""), pid: v.pid, startedAt: typeof v.startedAt === "string" ? v.startedAt : "" };
  } catch {
    return null;
  }
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class AppBridgeClient implements AppBridge {
  private readonly file: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly timeoutMs: number;

  constructor(opts: AppBridgeClientOptions) {
    this.file = opts.file;
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get path(): string {
    return this.file;
  }

  async locate(): Promise<{ info: AppBridgeFile } | { info: null; reason: string }> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return { info: null, reason: `no ${APP_BRIDGE_FILE} at ${this.file} (app not running, or not in dev / FABDESK_AUTOMATION=1 mode)` };
    }
    const info = parseAppBridgeFile(text);
    if (!info) return { info: null, reason: `${this.file} is not a valid app bridge file` };
    if (!this.pidAlive(info.pid)) return { info: null, reason: `app process ${info.pid} from ${this.file} is gone` };
    return { info };
  }

  async status(): Promise<AppBridgeStatus> {
    const located = await this.locate();
    if (!located.info) return { running: false, reason: located.reason };
    try {
      const res = await this.fetchImpl(`${located.info.url}/state`, { headers: this.headers(), signal: AbortSignal.timeout(2_000) });
      if (res.status === 401) return { running: false, url: located.info.url, pid: located.info.pid, reason: "bridge rejected the daemon token (app and core tokens differ)" };
      if (!res.ok) return { running: false, url: located.info.url, pid: located.info.pid, reason: `bridge answered ${res.status}` };
      return { running: true, url: located.info.url, pid: located.info.pid };
    } catch (e) {
      return { running: false, url: located.info.url, pid: located.info.pid, reason: `bridge unreachable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  async call<T = unknown>(method: "GET" | "POST", path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
    const located = await this.locate();
    if (!located.info) throw new ToolError(`fabPlane app bridge unavailable: ${located.reason}`, "unavailable");
    let res: Response;
    try {
      res = await this.fetchImpl(`${located.info.url}${path}`, {
        method,
        headers: { ...this.headers(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (e) {
      throw new ToolError(`fabPlane app bridge unreachable at ${located.info.url}: ${e instanceof Error ? e.message : String(e)}`, "unavailable");
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const msg = (json as { error?: unknown } | null)?.error;
      const detail = typeof msg === "string" ? msg : text.slice(0, 500) || res.statusText;
      if (res.status === 401) throw new ToolError("fabPlane app bridge rejected the daemon token (app and core tokens differ; restart the app)", "unavailable");
      const code = res.status === 400 ? "invalid_args" : res.status === 404 ? "not_found" : res.status === 503 ? "unavailable" : "internal";
      throw new ToolError(`app bridge ${method} ${path.split("?")[0]} failed (${res.status}): ${detail}`, code);
    }
    return json as T;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, accept: "application/json" };
  }
}
