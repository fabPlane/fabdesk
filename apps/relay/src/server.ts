/**
 * fabPlane relay — the reference implementation of the hosted relay a daemon dials out to so a
 * phone on cellular can reach it without an inbound port.
 *
 * Two kinds of peer:
 *
 * - A daemon opens `wss://<relay>/d?coreId=<coreId>` with its fabplane session as the bearer.
 *   The relay checks the bearer against `GET <apiOrigin>/v1/auth/me` (verdicts are cached for a
 *   few minutes so a reconnecting daemon does not hammer the API) and keeps one socket per
 *   `coreId` (a newer socket from the same user replaces the older; a different user is refused).
 * - A phone uses `https://<relay>/c/<coreId>/<path>` for HTTP and `wss://<relay>/c/<coreId>/ws`
 *   for the event stream. Its device token travels untouched in `Authorization`; the daemon
 *   enforces it. The relay only checks that a daemon is connected (else 503) and rate-limits by
 *   source address and by the daemon's owner.
 *
 * Operational surface: `/health` (no identifiers), `/metrics` (Prometheus text), JSON logs with
 * hashed identifiers, per-user limits (`./limits`), backpressure (`./flow`), ping-based idle
 * timeouts on both kinds of socket, and a graceful `shutdown()` that closes phones with 1012 so
 * they retry and daemons with 1012 so they reconnect to the replacement process.
 *
 * Frames are in `./protocol`. Streaming HTTP responses are not proxied (one `resp` per `open`);
 * clients use the WebSocket for events.
 */
import type { Server, ServerWebSocket } from "bun";
import { AuthCache } from "./auth-cache";
import { CLOSE_TRY_AGAIN_LATER, DEFAULT_FLOW, HeldQueue, type FlowConfig } from "./flow";
import { DEFAULT_LIMITS, DaemonLedger, type LimitConfig } from "./limits";
import { createLogger, jsonStdoutSink, type LogSink } from "./log";
import { Metrics } from "./metrics";
import { RateLimiter } from "./rate-limit";
import {
  CORE_ID_RE,
  DaemonToRelay,
  MAX_BODY_BYTES,
  decodeBody,
  encodeBody,
  encodingFor,
  forwardableHeaders,
  type RelayToDaemon,
} from "./protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface IdleConfig {
  /** A socket quiet for this long is pinged. */
  pingIntervalMs: number;
  /** A socket that has sent nothing (not even a pong) for this long is closed. */
  idleTimeoutMs: number;
}

export const DEFAULT_IDLE: IdleConfig = { pingIntervalMs: 30_000, idleTimeoutMs: 90_000 };

export interface RelayOptions {
  /** 0 picks a free port (tests). */
  port?: number;
  hostname?: string;
  /** fabplane API origin the daemon bearers are checked against. */
  apiOrigin: string;
  /** `globalThis.fetch` by default; tests hand in a fake `/v1/auth/me`. */
  fetch?: FetchLike;
  maxBodyBytes?: number;
  /** How long a proxied HTTP request may wait for the daemon's answer before 504. */
  requestTimeoutMs?: number;
  /** Per source address; `false` disables (tests). */
  rateLimit?: { capacity: number; perSecond: number } | false;
  /** Per-user caps; `false` disables (tests). */
  limits?: Partial<LimitConfig> | false;
  /** Backpressure thresholds on the daemon socket. */
  flow?: Partial<FlowConfig>;
  /** Ping / idle-close cadence; `false` leaves it to Bun's protocol-level timeout only. */
  idle?: Partial<IdleConfig> | false;
  /** How long a `/v1/auth/me` verdict is reused; 0 disables the cache. Default 5 minutes. */
  authCacheTtlMs?: number;
  /**
   * Log sink. Identifiers are hashed before they reach it (`coreId` → `core`, `userId` →
   * `user`). Default: JSON lines on stdout/stderr.
   */
  log?: LogSink;
}

export interface RelayServer {
  port: number;
  url: string;
  daemons(): Array<{ coreId: string; userId: string; connectedAt: number; clients: number }>;
  /** Drains: phones and daemons are closed with 1012, in-flight requests answered 503. */
  shutdown(opts?: { graceMs?: number }): Promise<void>;
  /** Immediate stop (tests). */
  stop(): void;
}

type DaemonConn = {
  ws: ServerWebSocket<WsData>;
  coreId: string;
  userId: string;
  connectedAt: number;
  pending: Map<string, { resolve: (r: Response) => void; timer: ReturnType<typeof setTimeout> }>;
  clients: Map<string, ServerWebSocket<WsData>>;
};

type DaemonData = {
  role: "daemon";
  coreId: string;
  userId: string;
  conn: DaemonConn | null;
  lastSeen: number;
};
type ClientData = {
  role: "client";
  coreId: string;
  sid: string;
  path: string;
  headers: Record<string, string>;
  daemon: DaemonConn | null;
  held: HeldQueue;
  lastSeen: number;
};
type WsData = DaemonData | ClientData;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Close codes the relay uses; 4xxx is the application range, 1012/1013 are standard. */
export const CLOSE_CORE_OFFLINE = 4503;
export const CLOSE_REPLACED = 4000;
export const CLOSE_IDLE = 4408;
export const CLOSE_RESTARTING = 1012;
export { CLOSE_TRY_AGAIN_LATER } from "./flow";

export function startRelay(opts: RelayOptions): RelayServer {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const apiOrigin = opts.apiOrigin.replace(/\/+$/, "");
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  const log = createLogger(opts.log ?? jsonStdoutSink);
  const limiter =
    opts.rateLimit === false
      ? null
      : new RateLimiter(opts.rateLimit?.capacity ?? 120, opts.rateLimit?.perSecond ?? 20);
  const limits: LimitConfig | null =
    opts.limits === false ? null : { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const userLimiter = limits
    ? new RateLimiter(limits.requestsPerMinutePerUser, limits.requestsPerMinutePerUser / 60)
    : null;
  const flow: FlowConfig = { ...DEFAULT_FLOW, ...(opts.flow ?? {}) };
  const idle: IdleConfig | null =
    opts.idle === false ? null : { ...DEFAULT_IDLE, ...(opts.idle ?? {}) };
  const authCache = new AuthCache(opts.authCacheTtlMs ?? 5 * 60_000);
  const metrics = new Metrics();
  const ledger = new DaemonLedger();
  const daemons = new Map<string, DaemonConn>();
  let shuttingDown = false;

  const clientCount = () => {
    let n = 0;
    for (const d of daemons.values()) n += d.clients.size;
    return n;
  };
  const pendingCount = () => {
    let n = 0;
    for (const d of daemons.values()) n += d.pending.size;
    return n;
  };
  const reject = (status: number, reason: string, error: string) => {
    metrics.reject(reason);
    return json(status, { error });
  };

  /** `GET /v1/auth/me` with the daemon's bearer; the subject is what identifies the owner. */
  const verifyBearer = async (bearer: string): Promise<string | null> => {
    const cached = authCache.get(bearer);
    if (cached) {
      metrics.authCacheHits += 1;
      return cached.userId;
    }
    metrics.authCacheMisses += 1;
    metrics.authChecksTotal += 1;
    const res = await fetchImpl(`${apiOrigin}/v1/auth/me`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
    let userId: string | null = null;
    if (res.status === 401 || res.status === 403) userId = null;
    else if (!res.ok) throw new Error(`auth check failed: ${res.status}`);
    else {
      const body = (await res.json()) as { user?: { subject?: unknown } | null };
      const subject = body.user?.subject;
      userId = typeof subject === "string" && subject ? subject : null;
    }
    authCache.set(bearer, { userId });
    return userId;
  };

  const sendToDaemon = (conn: DaemonConn, text: string) => {
    if (conn.ws.readyState !== 1) return;
    metrics.frame("to_daemon", Buffer.byteLength(text));
    conn.ws.send(text);
  };
  const sendFrame = (conn: DaemonConn, frame: RelayToDaemon) =>
    sendToDaemon(conn, JSON.stringify(frame));

  /** Forwards what a phone queued while its daemon was under backpressure. */
  const flushHeld = (conn: DaemonConn, client: ServerWebSocket<WsData>) => {
    if (client.data.role !== "client" || client.data.held.length === 0) return;
    client.data.held.flush((frame) => {
      if (conn.ws.getBufferedAmount() > flow.pauseAt) return false;
      sendToDaemon(conn, frame);
      return true;
    });
  };

  const handleDaemon = async (
    req: Request,
    server: Server,
    url: URL,
  ): Promise<Response | undefined> => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return reject(426, "not_websocket", "websocket required");
    if (shuttingDown) return reject(503, "shutting_down", "relay restarting");
    const coreId = url.searchParams.get("coreId") ?? "";
    if (!CORE_ID_RE.test(coreId)) return reject(400, "bad_core_id", "bad coreId");
    const bearer = req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();
    if (!bearer) return reject(401, "no_bearer", "bearer required");
    let userId: string | null;
    try {
      userId = await verifyBearer(bearer);
    } catch (e) {
      log("warn", "auth check unavailable", { error: e instanceof Error ? e.message : String(e) });
      return reject(502, "auth_unavailable", "auth unavailable");
    }
    if (!userId) return reject(401, "invalid_session", "invalid session");
    const existing = daemons.get(coreId);
    if (existing && existing.userId !== userId) {
      log("warn", "coreId claimed by another user", { coreId, userId });
      return reject(409, "core_owned_by_other", "coreId owned by another user");
    }
    if (limits && !ledger.allows(userId, coreId, limits.maxDaemonsPerUser)) {
      log("warn", "too many daemons for user", { userId, count: ledger.count(userId) });
      return reject(429, "too_many_daemons", "too many cores for this user");
    }
    const data: DaemonData = { role: "daemon", coreId, userId, conn: null, lastSeen: Date.now() };
    if (server.upgrade(req, { data })) return undefined;
    return reject(400, "upgrade_failed", "upgrade failed");
  };

  const handleClient = async (
    req: Request,
    server: Server,
    url: URL,
    coreId: string,
    rest: string,
  ): Promise<Response | undefined> => {
    if (limiter) {
      const ip = server.requestIP(req)?.address ?? "unknown";
      if (!limiter.take(ip)) return reject(429, "rate_limited_ip", "rate limited");
    }
    if (!CORE_ID_RE.test(coreId)) return reject(404, "bad_core_id", "not found");
    if (shuttingDown) return reject(503, "shutting_down", "relay restarting");
    const daemon = daemons.get(coreId);
    if (!daemon) return reject(503, "core_offline", "core offline");
    const path = rest + url.search;
    const sid = crypto.randomUUID();

    if (rest === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (limits && daemon.clients.size >= limits.maxClientsPerCore) {
        log("warn", "too many phone sockets for core", { coreId, count: daemon.clients.size });
        return reject(429, "too_many_clients", "too many connections for this core");
      }
      const headers: Record<string, string> = {};
      const auth = req.headers.get("authorization");
      if (auth) headers["authorization"] = auth;
      const data: ClientData = {
        role: "client",
        coreId,
        sid,
        path,
        headers,
        daemon: null,
        held: new HeldQueue(),
        lastSeen: Date.now(),
      };
      if (server.upgrade(req, { data })) return undefined;
      return reject(400, "upgrade_failed", "upgrade failed");
    }

    if (userLimiter && !userLimiter.take(daemon.userId))
      return reject(429, "rate_limited_user", "rate limited");
    if (daemon.ws.getBufferedAmount() > flow.closeAt) return reject(503, "core_busy", "core busy");
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > maxBody) return reject(413, "body_too_large", "body too large");
    let body: Uint8Array | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = new Uint8Array(await req.arrayBuffer());
      if (body.byteLength > maxBody) return reject(413, "body_too_large", "body too large");
    }
    const bodyEncoding = encodingFor(req.headers.get("content-type"));
    const frame: RelayToDaemon = {
      t: "open",
      sid,
      method: req.method,
      path,
      headers: forwardableHeaders(req.headers),
      ...(body && body.byteLength ? { body: encodeBody(body, bodyEncoding), bodyEncoding } : {}),
    };
    metrics.httpRequestsTotal += 1;
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        daemon.pending.delete(sid);
        metrics.reject("core_timeout");
        resolve(json(504, { error: "core timed out" }));
      }, requestTimeoutMs);
      daemon.pending.set(sid, { resolve, timer });
      sendFrame(daemon, frame);
    });
  };

  const health = () => {
    const body = {
      ok: !shuttingDown,
      uptimeSeconds: metrics.uptimeSeconds(),
      daemons: daemons.size,
      clients: clientCount(),
      ...(shuttingDown ? { shuttingDown: true } : {}),
    };
    return json(shuttingDown ? 503 : 200, body);
  };

  const renderMetrics = () =>
    new Response(
      metrics.render({
        daemons: daemons.size,
        clients: clientCount(),
        pending: pendingCount(),
        authCacheEntries: authCache.size,
        shuttingDown,
      }),
      { headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" } },
    );

  /** Fails every in-flight request and closes every phone of `conn`. */
  const dropDaemonClients = (
    conn: DaemonConn,
    status: number,
    error: string,
    code: number,
    reason: string,
  ) => {
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      p.resolve(json(status, { error }));
    }
    conn.pending.clear();
    for (const [, client] of conn.clients) client.close(code, reason);
    conn.clients.clear();
  };

  const server = Bun.serve<WsData, Record<never, never>>({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 4040,
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return health();
      if (url.pathname === "/metrics") return renderMetrics();
      if (url.pathname === "/d") return handleDaemon(req, srv, url);
      const m = /^\/c\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (m) return handleClient(req, srv, url, m[1]!, m[2] ?? "/");
      return reject(404, "not_found", "not found");
    },
    websocket: {
      // The largest legitimate frame is a 4 MB body as base64 plus headers.
      maxPayloadLength: 8 * 1024 * 1024,
      // Our own flow control acts well before uWS would start dropping frames.
      backpressureLimit: Math.max(64 * 1024 * 1024, flow.closeAt * 4),
      // Protocol-level backstop; `idle` above is the configurable one.
      idleTimeout: 255,
      sendPings: true,
      open(ws) {
        ws.data.lastSeen = Date.now();
        if (ws.data.role === "daemon") {
          const conn: DaemonConn = {
            ws,
            coreId: ws.data.coreId,
            userId: ws.data.userId,
            connectedAt: Date.now(),
            pending: new Map(),
            clients: new Map(),
          };
          ws.data.conn = conn;
          const old = daemons.get(conn.coreId);
          daemons.set(conn.coreId, conn);
          ledger.add(conn.userId, conn.coreId);
          metrics.daemonConnectionsTotal += 1;
          if (old) {
            log("info", "daemon replaced", { coreId: conn.coreId, userId: conn.userId });
            old.ws.close(CLOSE_REPLACED, "replaced by a newer connection");
          } else log("info", "daemon connected", { coreId: conn.coreId, userId: conn.userId });
          return;
        }
        const daemon = daemons.get(ws.data.coreId);
        if (!daemon) {
          metrics.reject("core_offline");
          ws.close(CLOSE_CORE_OFFLINE, "core offline");
          return;
        }
        ws.data.daemon = daemon;
        daemon.clients.set(ws.data.sid, ws);
        metrics.clientSocketsTotal += 1;
        sendFrame(daemon, {
          t: "ws-open",
          sid: ws.data.sid,
          path: ws.data.path,
          headers: ws.data.headers,
        });
      },
      message(ws, raw) {
        ws.data.lastSeen = Date.now();
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        if (ws.data.role === "client") {
          const daemon = ws.data.daemon;
          if (!daemon) return;
          metrics.frame("from_client", Buffer.byteLength(text));
          const frame = JSON.stringify({ t: "ws-msg", sid: ws.data.sid, data: text });
          if (ws.data.held.length === 0 && daemon.ws.getBufferedAmount() <= flow.pauseAt) {
            sendToDaemon(daemon, frame);
            return;
          }
          if (!ws.data.held.push(frame, flow.closeAt)) {
            metrics.backpressureClosesTotal += 1;
            metrics.reject("backpressure");
            log("warn", "phone closed: daemon backpressure", { coreId: ws.data.coreId });
            ws.close(CLOSE_TRY_AGAIN_LATER, "core is not keeping up");
          }
          return;
        }
        const conn = ws.data.conn;
        if (!conn) return;
        metrics.frame("from_daemon", Buffer.byteLength(text));
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          metrics.reject("bad_frame");
          log("warn", "bad daemon frame", { coreId: conn.coreId, issue: "not JSON" });
          return;
        }
        const frame = DaemonToRelay.safeParse(parsed);
        if (!frame.success) {
          metrics.reject("bad_frame");
          log("warn", "bad daemon frame", {
            coreId: conn.coreId,
            issue: frame.error.issues[0]?.message,
          });
          return;
        }
        const f = frame.data;
        if (f.t === "resp") {
          const p = conn.pending.get(f.sid);
          if (!p) return;
          conn.pending.delete(f.sid);
          clearTimeout(p.timer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(f.headers)) headers.set(k, v);
          headers.delete("content-length");
          headers.delete("transfer-encoding");
          headers.delete("content-encoding");
          const body = decodeBody(f.body, f.bodyEncoding);
          p.resolve(
            new Response(f.status === 204 || f.status === 304 ? null : body, {
              status: f.status,
              headers,
            }),
          );
        } else if (f.t === "ws-msg") {
          const client = conn.clients.get(f.sid);
          if (!client) return;
          if (client.getBufferedAmount() > flow.closeAt) {
            metrics.backpressureClosesTotal += 1;
            metrics.reject("backpressure");
            log("warn", "phone closed: not reading", { coreId: conn.coreId });
            client.close(CLOSE_TRY_AGAIN_LATER, "phone is not keeping up");
            return;
          }
          metrics.frame("to_client", Buffer.byteLength(f.data));
          client.send(f.data);
        } else {
          const client = conn.clients.get(f.sid);
          if (client) {
            conn.clients.delete(f.sid);
            client.close(f.code ?? 1000, f.reason ?? "");
          }
        }
      },
      drain(ws) {
        if (ws.data.role !== "daemon" || !ws.data.conn) return;
        const conn = ws.data.conn;
        // Writing to the socket from inside its own `drain` callback loses the writable
        // interest in Bun 1.4 (the buffer then sits until the next unrelated send), so the
        // flush runs on the next tick instead.
        setTimeout(() => {
          if (daemons.get(conn.coreId) !== conn) return;
          for (const [, client] of conn.clients) flushHeld(conn, client);
        }, 0);
      },
      pong(ws) {
        ws.data.lastSeen = Date.now();
      },
      close(ws) {
        if (ws.data.role === "client") {
          ws.data.held.clear();
          const daemon = ws.data.daemon;
          if (daemon && daemon.clients.delete(ws.data.sid))
            sendFrame(daemon, { t: "close", sid: ws.data.sid });
          return;
        }
        const conn = ws.data.conn;
        if (!conn) return;
        dropDaemonClients(conn, 502, "core disconnected", CLOSE_CORE_OFFLINE, "core disconnected");
        if (daemons.get(conn.coreId) === conn) {
          daemons.delete(conn.coreId);
          ledger.remove(conn.userId, conn.coreId);
          log("info", "daemon disconnected", { coreId: conn.coreId, userId: conn.userId });
        }
      },
    },
  });

  /** Pings quiet sockets, closes silent ones, and retries held phone frames. */
  const sweep = () => {
    if (!idle) return;
    const now = Date.now();
    const check = (ws: ServerWebSocket<WsData>) => {
      if (ws.readyState !== 1) return;
      const quiet = now - ws.data.lastSeen;
      if (quiet > idle.idleTimeoutMs) {
        metrics.idleClosesTotal += 1;
        log("info", `${ws.data.role} closed: idle`, { coreId: ws.data.coreId, quietMs: quiet });
        ws.close(CLOSE_IDLE, "idle timeout");
      } else if (quiet >= idle.pingIntervalMs) ws.ping();
    };
    for (const conn of daemons.values()) {
      check(conn.ws);
      for (const [, client] of conn.clients) {
        flushHeld(conn, client);
        check(client);
      }
    }
  };
  const sweeper = idle
    ? setInterval(sweep, Math.max(10, Math.min(idle.pingIntervalMs, idle.idleTimeoutMs) / 2))
    : null;

  const port = server.port ?? opts.port ?? 4040;
  const stop = () => {
    if (sweeper) clearInterval(sweeper);
    server.stop(true);
  };
  const shutdown = async ({ graceMs = 250 }: { graceMs?: number } = {}) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (sweeper) clearInterval(sweeper);
    log("info", "shutting down", { daemons: daemons.size, clients: clientCount() });
    for (const conn of [...daemons.values()]) {
      dropDaemonClients(conn, 503, "relay restarting", CLOSE_RESTARTING, "relay restarting");
      conn.ws.close(CLOSE_RESTARTING, "relay restarting");
    }
    // Let the close frames leave before the listener goes away.
    await Bun.sleep(graceMs);
    server.stop(true);
  };
  log("info", "listening", { port });
  return {
    port,
    url: `http://${opts.hostname && opts.hostname !== "0.0.0.0" ? opts.hostname : "127.0.0.1"}:${port}`,
    daemons: () =>
      [...daemons.values()].map((d) => ({
        coreId: d.coreId,
        userId: d.userId,
        connectedAt: d.connectedAt,
        clients: d.clients.size,
      })),
    shutdown,
    stop,
  };
}
