/**
 * The daemon's end of the relay (`apps/relay`): an outbound WebSocket a phone off the tailnet can
 * reach the daemon through, with no inbound port.
 *
 * Whenever remote access is on, `Settings.remote.relay` is not `off` and the daemon is signed in
 * to fabplane, this dials `wss://<relay>/d?coreId=<coreId>` with the session bearer and answers
 * the relay's frames. The relay is `Settings.remote.relayUrl` when set, else the default derived
 * from the fabplane API origin (`defaultRelayUrl`), so nothing needs configuring. Frames:
 * `open` (an HTTP request) is served by the **remote** Hono app — the same narrowed surface a
 * phone on the tailnet gets, so MCP, shutdown and device administration stay 404 — and `ws-open`
 * attaches the phone to the event bus exactly as `/ws` does. The device token the phone sends
 * travels inside the frames and is checked here, never by the relay.
 *
 * Frames mirror `apps/relay/src/protocol.ts`; that package stays free of fabdesk imports so it
 * can be ported, hence the copy rather than a dependency.
 */
import { z } from "zod/v4";
import type { CoreEvent, RelayPhase, RelayStatus, Settings } from "@fabdesk/protocol";
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

/** The relay to use when `remote.relayUrl` is empty, or why there is none (see `defaultRelayUrl`). */
export type RelayDefault =
  | { url: string; source: "setting" | "env" | "derived" | "api" }
  | { url: null; reason: string };

export interface RelayLinkOptions {
  coreId: string;
  /** The fabplane session bearer, null while signed out. Read on every dial so a fresh sign-in is picked up. */
  token: () => string | null;
  /** The relay for an empty `remote.relayUrl`. Re-read on every `apply`, so a late discovery is picked up. */
  defaultRelay?: () => RelayDefault;
  /** Where `remote.relay` events go. */
  emit?: (event: CoreEvent) => void;
  socketFactory?: (url: string, headers: Record<string, string>) => RelaySocket;
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
}

/** `RemoteStatus.relay`: null when `remote.relay` is `off`. */
export type RelayState = RelayStatus | null;

/** Longest wait between redials; the backoff is capped here even after jitter. */
export const RELAY_MAX_DELAY_MS = 60_000;

/**
 * Exponential backoff with ±25 % jitter, hard-capped at `max`: 1 s, 2 s, 4 s … then `max`
 * forever (`attempt` counts from 1). `random` is injectable for tests.
 */
export function backoffDelay(
  attempt: number,
  { base = 1000, max = RELAY_MAX_DELAY_MS, random = Math.random } = {},
): number {
  const exp = base * 2 ** Math.min(Math.max(attempt, 1) - 1, 10);
  return Math.min(max, exp * (0.75 + random() * 0.5));
}

/**
 * The relay for a fabplane API origin when nothing is configured: `FABPLANE_RELAY_URL` when set
 * (empty means "none", an explicit opt-out), else `api.<domain>` → `relay.<domain>` on the same
 * scheme and port — `https://api.fabplane.com` → `wss://relay.fabplane.com`. Any other origin
 * (the staging host's Tailscale name, a local API) has no derivable relay; `discoverRelayUrl`
 * asks the API itself, and the env override is the fallback.
 */
export function defaultRelayUrl(
  apiOrigin: string,
  env: NodeJS.ProcessEnv = process.env,
): RelayDefault {
  const override = env["FABPLANE_RELAY_URL"];
  if (override !== undefined) {
    const url = override.trim();
    return url
      ? { url, source: "env" }
      : { url: null, reason: "FABPLANE_RELAY_URL is empty, so no relay is used" };
  }
  let u: URL;
  try {
    u = new URL(apiOrigin);
  } catch {
    return { url: null, reason: `the API origin is not a URL: ${apiOrigin}` };
  }
  if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname.startsWith("api.")) {
    const scheme = u.protocol === "https:" ? "wss" : "ws";
    const host = `relay.${u.hostname.slice("api.".length)}${u.port ? `:${u.port}` : ""}`;
    return { url: `${scheme}://${host}`, source: "derived" };
  }
  return {
    url: null,
    reason: `no relay is published for ${u.origin}; set FABPLANE_RELAY_URL to use one`,
  };
}

/**
 * Asks the fabplane API which relay serves it: `GET <origin>/v1/config` answering
 * `{ relayUrl: "wss://…" }` (or `{ relay: { url } }`). Null when the API has no such route yet,
 * publishes none, or cannot be reached — the caller keeps the derived default or the env override.
 */
export async function discoverRelayUrl(
  apiOrigin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${apiOrigin.replace(/\/+$/, "")}/v1/config`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { relayUrl?: unknown; relay?: { url?: unknown } | null };
    const url = typeof body.relayUrl === "string" ? body.relayUrl : body.relay?.url;
    return typeof url === "string" && url.trim() ? url.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Serves `defaultRelayUrl` synchronously and, when that yields nothing, asks the API once in a
 * while (`discoverRelayUrl`); a discovery that finds a relay is reported through `onChange` so
 * the link can be re-applied. Env and derived defaults are never overridden by discovery.
 */
export class RelayDefaultResolver {
  private discovered: string | null = null;
  private probing: Promise<void> | null = null;
  private probedAt: number | null = null;

  constructor(
    private readonly opts: {
      apiOrigin: string;
      env?: NodeJS.ProcessEnv;
      fetchImpl?: typeof fetch;
      onChange?: () => void;
      /** How long a fruitless probe is remembered before the API is asked again. */
      retryAfterMs?: number;
      now?: () => number;
    },
  ) {}

  current(): RelayDefault {
    const env = this.opts.env ?? process.env;
    const d = defaultRelayUrl(this.opts.apiOrigin, env);
    if (d.url) return d;
    if (this.discovered) return { url: this.discovered, source: "api" };
    if (env["FABPLANE_RELAY_URL"] === undefined) this.probe();
    return d;
  }

  /** Resolves once no probe is in flight (tests, shutdown). */
  settled(): Promise<void> {
    return this.probing ?? Promise.resolve();
  }

  private probe(): void {
    const now = this.opts.now?.() ?? Date.now();
    if (
      this.probing ||
      (this.probedAt !== null && now - this.probedAt < (this.opts.retryAfterMs ?? 5 * 60_000))
    )
      return;
    this.probedAt = now;
    this.probing = discoverRelayUrl(this.opts.apiOrigin, this.opts.fetchImpl).then((url) => {
      this.probing = null;
      if (url && url !== this.discovered) {
        this.discovered = url;
        logger.info("relay discovered from the API", { url });
        this.opts.onChange?.();
      }
    });
  }
}

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

/**
 * Set on every request and event socket the link hands to the app, so the device row can record
 * which path the phone used (`Device.via`). Whatever the phone sent under it is dropped first.
 */
export const VIA_HEADER = "x-fabdesk-via";

/** The relay's hostname stands in for the daemon's own in proxied requests; nothing routes on it. */
const PROXY_ORIGIN = "http://relay.invalid";

const DROP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  VIA_HEADER,
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
  /** The dial target while the link is wanted (dialing, connected, or waiting to redial). */
  private wanted: { setting: string; url: string; endpoint: RelayEndpoint } | null = null;
  /** Why the link is not wanted right now, in `auto` mode (null when `off` or wanted). */
  private blocked: { url: string; error: string } | null = null;
  private socket: RelaySocket | null = null;
  private connected = false;
  private sinceMs: number | null = null;
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
    const lastError = this.lastError ? { lastError: this.lastError } : {};
    if (this.wanted)
      return {
        connected: this.connected,
        url: this.wanted.setting,
        ...(this.sinceMs !== null ? { since: new Date(this.sinceMs).toISOString() } : {}),
        ...lastError,
      };
    if (this.blocked)
      return { connected: false, url: this.blocked.url, error: this.blocked.error, ...lastError };
    return null;
  }

  /** `/health`'s view: up, trying, or not trying (off, blocked, or never configured). */
  phase(): RelayPhase {
    if (this.connected) return "connected";
    return this.wanted ? "connecting" : "off";
  }

  /** The endpoint to advertise in pairing URLs; null unless the link is up right now. */
  endpoint(): RelayEndpoint | null {
    return this.wanted && this.connected ? this.wanted.endpoint : null;
  }

  /**
   * Brings the link in line with the setting and the sign-in state: dials, redials, or hangs up.
   * The relay is the explicit `relayUrl`, else the default; the link is wanted only while remote
   * access is on, the mode is not `off`, and the daemon is signed in.
   */
  apply(remote: Settings["remote"]): RelayState {
    if ((remote.relay ?? "auto") === "off") {
      if (this.wanted) logger.info("relay link off");
      this.stop();
      return null;
    }
    const explicit = remote.relayUrl?.trim() || null;
    const target: RelayDefault = explicit
      ? { url: explicit, source: "setting" }
      : (this.opts.defaultRelay?.() ?? { url: null, reason: "no relay is configured" });
    if (target.url === null) return this.block("", target.reason);
    const dial = relayDialUrl(target.url, this.opts.coreId);
    if ("error" in dial) return this.block(target.url, dial.error);
    if (!remote.enabled) return this.block(target.url, "remote access is off");
    if (!this.opts.token()) return this.block(target.url, "not signed in");
    if (this.wanted?.url === dial.url && (this.socket || this.timer)) return this.state();
    this.hangUp();
    this.wanted = { setting: target.url, ...dial };
    this.blocked = null;
    this.lastError = null;
    this.attempt = 0;
    this.sinceMs = this.now();
    logger.info("relay link starting", { url: target.url, source: target.source });
    this.connect();
    return this.state();
  }

  stop(): void {
    this.hangUp();
    this.wanted = null;
    this.blocked = null;
    this.lastError = null;
    this.sinceMs = null;
  }

  private block(url: string, error: string): RelayState {
    if (this.wanted) logger.info("relay link paused", { url, reason: error });
    else if (this.blocked?.error !== error)
      logger.info("relay link not started", { url, reason: error });
    this.hangUp();
    this.wanted = null;
    this.blocked = { url, error };
    return this.state();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** Flips `connected`, stamps `since`, and tells the bus; a no-op when nothing changed. */
  private setConnected(connected: boolean, error?: string): void {
    if (this.connected === connected) return;
    this.connected = connected;
    this.sinceMs = this.now();
    this.opts.emit?.({
      topic: "remote.relay",
      ts: this.sinceMs,
      connected,
      url: this.wanted?.setting ?? "",
      ...(error ? { error } : {}),
    });
  }

  private hangUp(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const s = this.socket;
    this.socket = null;
    this.setConnected(false, "relay link stopped");
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
      this.block(wanted.setting, "not signed in");
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
      this.attempt = 0;
      this.setConnected(true);
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
      const reason = ev.reason || (ev.code ? `closed (${ev.code})` : "closed");
      this.lastError = reason;
      this.setConnected(false, reason);
      this.closeSessions();
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
    const delay = backoffDelay(this.attempt, {
      base: this.opts.baseDelayMs ?? 1000,
      max: this.opts.maxDelayMs ?? RELAY_MAX_DELAY_MS,
    });
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
        const headers = new Headers(f.headers ?? {});
        headers.set(VIA_HEADER, "relay");
        const session = handlers.openEvents(url, headers, (data) =>
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
    headers.set(VIA_HEADER, "relay");
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
