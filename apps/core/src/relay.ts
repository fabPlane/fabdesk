/**
 * The daemon's end of the relay (`apps/relay`): an outbound WebSocket a phone off the tailnet can
 * reach the daemon through, with no inbound port.
 *
 * When `Settings.remote.relayUrl` is set and the daemon is signed in to fabplane, this dials
 * `wss://<relay>/d?coreId=<coreId>` with the session bearer and answers the relay's frames:
 * `open` (an HTTP request) is served by the **remote** Hono app — the same narrowed surface a
 * phone on the tailnet gets, so MCP, shutdown and device administration stay 404 — and `ws-open`
 * attaches the phone to the event bus exactly as `/ws` does. The device token the phone sends
 * travels inside the frames and is checked here, never by the relay.
 *
 * Frames mirror `apps/relay/src/protocol.ts`; that package stays free of fabdesk imports so it
 * can be ported, hence the copy rather than a dependency.
 */
import { z } from "zod/v4";
import type { Settings } from "@fabdesk/protocol";
import { errMsg, logger } from "./log";

/** One proxied `/ws` client, attached to the bus the way the listener's own sockets are. */
export interface EventSession {
  message(raw: string): void;
  close(): void;
}

export interface RelayHandlers {
  /** The remote listener's app. */
  fetch: (req: Request) => Response | Promise<Response>;
  /** Opens an event session for a `/ws` URL and its headers; null when the credential is refused. */
  openEvents: (url: URL, headers: Headers, send: (data: string) => void) => EventSession | null;
}

/** The subset of a WebSocket client the link uses; Bun's `WebSocket` (with request headers) fits. */
export interface RelaySocket {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayLinkOptions {
  coreId: string;
  /** The fabplane session bearer, null while signed out. Read on every dial so a fresh sign-in is picked up. */
  token: () => string | null;
  socketFactory?: (url: string, headers: Record<string, string>) => RelaySocket;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export type RelayState = { connected: boolean; url: string; error?: string } | null;

/** What `listenAddresses`' caller merges into the advertised endpoints when the link is configured. */
export type RelayEndpoint = {
  kind: "relay";
  /** `hostname[:port]`, what the pairing URL's `h=` carries; the phone rebuilds `<scheme>://<host>`. */
  host: string;
  hostname: string;
  port: number;
  scheme: "http" | "https";
  iface: "relay";
  default: false;
};

const Sid = z.string().min(1).max(64);
const BodyEncoding = z.enum(["utf8", "base64"]);
const HeaderMap = z.record(z.string(), z.string());
const RelayFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("open"),
    sid: Sid,
    method: z.string().min(1).max(16),
    path: z.string().min(1),
    headers: HeaderMap,
    body: z.string().optional(),
    bodyEncoding: BodyEncoding.optional(),
  }),
  z.object({
    t: z.literal("ws-open"),
    sid: Sid,
    path: z.string().min(1),
    headers: HeaderMap.optional(),
  }),
  z.object({ t: z.literal("ws-msg"), sid: Sid, data: z.string() }),
  z.object({
    t: z.literal("close"),
    sid: Sid,
    code: z.number().int().optional(),
    reason: z.string().optional(),
  }),
]);
type RelayFrame = z.infer<typeof RelayFrame>;
type DaemonFrame =
  | {
      t: "resp";
      sid: string;
      status: number;
      headers: Record<string, string>;
      body: string;
      bodyEncoding: "utf8" | "base64";
    }
  | { t: "ws-msg"; sid: string; data: string }
  | { t: "close"; sid: string; code?: number; reason?: string };

/** Close code the daemon sends when a proxied `/ws` presents no usable credential. */
export const CLOSE_UNAUTHORIZED = 4401;

/** The relay's hostname stands in for the daemon's own in proxied requests; nothing routes on it. */
const PROXY_ORIGIN = "http://relay.invalid";

const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
]);

function textish(contentType: string | null): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return (
    ct.startsWith("text/") || ct.includes("json") || ct.includes("xml") || ct.includes("urlencoded")
  );
}

/** Where the relay's `/d` lives for a configured URL, or an explanation of why the setting is unusable. */
export function relayDialUrl(
  relayUrl: string,
  coreId: string,
): { url: string; endpoint: RelayEndpoint } | { error: string } {
  let u: URL;
  try {
    u = new URL(relayUrl.trim());
  } catch {
    return { error: `relayUrl is not a URL: ${relayUrl}` };
  }
  if (
    u.protocol !== "https:" &&
    u.protocol !== "http:" &&
    u.protocol !== "wss:" &&
    u.protocol !== "ws:"
  )
    return { error: `relayUrl must be http(s) or ws(s): ${relayUrl}` };
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  const base = `${secure ? "wss" : "ws"}://${u.host}${u.pathname.replace(/\/+$/, "")}`;
  const port = u.port ? Number(u.port) : secure ? 443 : 80;
  return {
    url: `${base}/d?coreId=${encodeURIComponent(coreId)}`,
    endpoint: {
      kind: "relay",
      host: u.host,
      hostname: u.hostname,
      port,
      scheme: secure ? "https" : "http",
      iface: "relay",
      default: false,
    },
  };
}

export class RelayLink {
  private handlers: RelayHandlers | null = null;
  private wanted: { setting: string; url: string; endpoint: RelayEndpoint } | null = null;
  private socket: RelaySocket | null = null;
  private connected = false;
  private lastError: string | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly sessions = new Map<string, EventSession>();
  private readonly factory: (url: string, headers: Record<string, string>) => RelaySocket;

  constructor(private readonly opts: RelayLinkOptions) {
    this.factory =
      opts.socketFactory ??
      ((url, headers) => new WebSocket(url, { headers } as never) as unknown as RelaySocket);
  }

  /** The request handlers are built after the app, so they arrive separately (as for `RemoteListener`). */
  attach(handlers: RelayHandlers): void {
    this.handlers = handlers;
    if (this.wanted && !this.socket) this.connect();
  }

  state(): RelayState {
    if (!this.wanted) return null;
    return {
      connected: this.connected,
      url: this.wanted.setting,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** The endpoint to advertise in pairing URLs; null unless the link is configured and the daemon signed in. */
  endpoint(): RelayEndpoint | null {
    return this.wanted && this.opts.token() ? this.wanted.endpoint : null;
  }

  /** Brings the link in line with the setting and the sign-in state: dials, redials, or hangs up. */
  apply(remote: Settings["remote"]): RelayState {
    const setting = remote.relayUrl?.trim() || null;
    if (!setting || !this.opts.token()) {
      if (this.wanted) logger.info(setting ? "relay link paused: not signed in" : "relay link off");
      this.stop();
      if (setting) {
        // Keep reporting the configured URL so Settings can say why it is not connected.
        const dial = relayDialUrl(setting, this.opts.coreId);
        this.wanted = "error" in dial ? null : { setting, ...dial };
        this.lastError = "error" in dial ? dial.error : "not signed in";
      }
      return this.state();
    }
    const dial = relayDialUrl(setting, this.opts.coreId);
    if ("error" in dial) {
      this.stop();
      logger.warn("relay link not started", { error: dial.error });
      this.lastError = dial.error;
      return this.state();
    }
    if (this.wanted?.url === dial.url && (this.socket || this.timer)) return this.state();
    this.hangUp();
    this.wanted = { setting, ...dial };
    this.lastError = null;
    this.attempt = 0;
    this.connect();
    return this.state();
  }

  stop(): void {
    this.hangUp();
    this.wanted = null;
    this.lastError = null;
  }

  private hangUp(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    this.connected = false;
    this.closeSessions();
    if (s) {
      s.onclose = null;
      s.onerror = null;
      s.onmessage = null;
      s.onopen = null;
      try {
        s.close(1000, "relay link stopped");
      } catch {
        /* already gone */
      }
    }
  }

  private closeSessions(): void {
    for (const [, session] of this.sessions) session.close();
    this.sessions.clear();
  }

  private connect(): void {
    const wanted = this.wanted;
    if (!wanted || !this.handlers || this.socket) return;
    this.timer = null;
    const token = this.opts.token();
    if (!token) {
      this.lastError = "not signed in";
      return;
    }
    let ws: RelaySocket;
    try {
      ws = this.factory(wanted.url, { authorization: `Bearer ${token}` });
    } catch (e) {
      this.lastError = errMsg(e);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.connected = true;
      this.lastError = null;
      this.attempt = 0;
      logger.info("relay link connected", { url: wanted.setting });
    };
    ws.onmessage = (ev) => {
      if (this.socket === ws) void this.handleFrame(ws, ev.data);
    };
    ws.onerror = () => {
      if (this.socket === ws) this.lastError = "relay socket error";
    };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      const wasConnected = this.connected;
      this.socket = null;
      this.connected = false;
      this.closeSessions();
      if (ev.reason) this.lastError = ev.reason;
      logger[wasConnected ? "info" : "warn"]("relay link closed", {
        url: wanted.setting,
        code: ev.code,
        reason: ev.reason,
      });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.wanted || this.timer) return;
    this.attempt += 1;
    const base = this.opts.baseDelayMs ?? 1000;
    const max = this.opts.maxDelayMs ?? 30_000;
    const delay =
      Math.min(max, base * 2 ** Math.min(this.attempt - 1, 10)) * (0.75 + Math.random() * 0.5);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private send(ws: RelaySocket, frame: DaemonFrame): void {
    if (this.socket === ws && ws.readyState === 1) ws.send(JSON.stringify(frame));
  }

  private async handleFrame(ws: RelaySocket, raw: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer),
      );
    } catch {
      return;
    }
    const frame = RelayFrame.safeParse(parsed);
    if (!frame.success) {
      logger.warn("relay: bad frame", { issue: frame.error.issues[0]?.message });
      return;
    }
    const f = frame.data;
    switch (f.t) {
      case "open":
        return this.serveRequest(ws, f);
      case "ws-open": {
        const handlers = this.handlers;
        if (!handlers) return;
        const url = new URL(`${PROXY_ORIGIN}${f.path}`);
        const session = handlers.openEvents(url, new Headers(f.headers ?? {}), (data) =>
          this.send(ws, { t: "ws-msg", sid: f.sid, data }),
        );
        if (!session) {
          this.send(ws, {
            t: "close",
            sid: f.sid,
            code: CLOSE_UNAUTHORIZED,
            reason: "unauthorized",
          });
          return;
        }
        this.sessions.set(f.sid, session);
        return;
      }
      case "ws-msg":
        this.sessions.get(f.sid)?.message(f.data);
        return;
      case "close": {
        const session = this.sessions.get(f.sid);
        this.sessions.delete(f.sid);
        session?.close();
        return;
      }
    }
  }

  private async serveRequest(
    ws: RelaySocket,
    f: Extract<RelayFrame, { t: "open" }>,
  ): Promise<void> {
    const handlers = this.handlers;
    if (!handlers) return;
    const headers = new Headers();
    for (const [k, v] of Object.entries(f.headers))
      if (!DROP_HEADERS.has(k.toLowerCase()) && k.toLowerCase() !== "host") headers.set(k, v);
    const body =
      f.body !== undefined
        ? f.bodyEncoding === "base64"
          ? new Uint8Array(Buffer.from(f.body, "base64"))
          : new TextEncoder().encode(f.body)
        : null;
    let res: Response;
    try {
      const req = new Request(`${PROXY_ORIGIN}${f.path}`, {
        method: f.method,
        headers,
        ...(body && f.method !== "GET" && f.method !== "HEAD" ? { body } : {}),
      });
      res = await handlers.fetch(req);
      // One `resp` per `open`: an SSE body would never end. Phones ride `/ws` for events instead.
      if ((res.headers.get("content-type") ?? "").toLowerCase().startsWith("text/event-stream")) {
        await res.body?.cancel().catch(() => {});
        res = Response.json(
          { error: "streaming responses are not proxied; use /ws", code: "unavailable" },
          { status: 501 },
        );
      }
    } catch (e) {
      logger.warn("relay: proxied request failed", { path: f.path, error: errMsg(e) });
      res = Response.json({ error: errMsg(e), code: "internal" }, { status: 500 });
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const encoding = textish(res.headers.get("content-type")) ? "utf8" : "base64";
    const outHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      if (!DROP_HEADERS.has(k)) outHeaders[k] = v;
    });
    this.send(ws, {
      t: "resp",
      sid: f.sid,
      status: res.status,
      headers: outHeaders,
      body:
        encoding === "utf8"
          ? new TextDecoder().decode(bytes)
          : Buffer.from(bytes).toString("base64"),
      bodyEncoding: encoding,
    });
  }
}
