/**
 * HTTP client for a FabPlane CAD bridge (`@fab-cad/bridge` on fabPlane/fab_cad): sessions, one
 * `FreeCADApiServer` per project. Same shape as `FpPcbBridgeClient`: every failure to reach the
 * bridge is a `ToolError("unavailable")` with the reason, so tools can say what is missing. The
 * FreeCAD API itself goes over the bridge's `/ws` through `@fab-cad/client` (`./fab-cad`).
 */
import { FabCadHealth, FabCadSession } from "@fabdesk/protocol";
import { ToolError } from "@fabdesk/tools";

export type FabCadBridgeClientOptions = {
  /** Origin, e.g. `http://127.0.0.1:4030`. */
  url: string;
  fetch?: typeof fetch;
  /** Per-request timeout; creating a session waits for FreeCAD to start, so it gets longer. */
  timeoutMs?: number;
};

export class FabCadBridgeClient {
  readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FabCadBridgeClientOptions) {
    this.url = opts.url.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async health(): Promise<FabCadHealth> {
    return FabCadHealth.parse(await this.json("GET", "/health"));
  }

  async sessions(): Promise<FabCadSession[]> {
    const res = (await this.json("GET", "/sessions")) as { sessions?: unknown[] };
    return (res.sessions ?? []).map((s) => FabCadSession.parse(s));
  }

  /** `path` is a `.FCStd` on the bridge's filesystem (inside its workspace root); null starts a bare server. */
  async createSession(path: string | null): Promise<FabCadSession> {
    const res = (await this.json("POST", "/sessions", path ? { path } : {}, 90_000)) as {
      session: unknown;
    };
    return FabCadSession.parse(res.session);
  }

  async deleteSession(id: string): Promise<void> {
    await this.json("DELETE", `/sessions/${encodeURIComponent(id)}`);
  }

  /** The WebSocket a FreeCAD API client dials for `session`. */
  wsUrl(session: string): string {
    const u = new URL(`/ws?session=${encodeURIComponent(session)}`, this.url);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }

  private async json(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ToolError(
        `FabPlane CAD bridge unreachable at ${this.url}: ${e instanceof Error ? e.message : String(e)}`,
        "unavailable",
      );
    }
    if (!res.ok) {
      let detail = "";
      try {
        const json = (await res.json()) as { error?: unknown };
        if (typeof json.error === "string") detail = json.error;
      } catch {
        /* no body */
      }
      throw new ToolError(
        `FabPlane CAD bridge ${res.status} on ${path}${detail ? `: ${detail}` : ""}`,
        res.status === 404 ? "not_found" : res.status === 400 ? "invalid_args" : "unavailable",
      );
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}
