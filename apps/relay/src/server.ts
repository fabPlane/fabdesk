/**
 * fabPlane relay — the reference implementation of the hosted relay a daemon dials out to so a
 * phone on cellular can reach it without an inbound port.
 *
 * Two kinds of peer:
 *
 * - A daemon opens `wss://<relay>/d?coreId=<coreId>` with its fabplane session as the bearer.
 *   The relay checks the bearer against `GET <apiOrigin>/v1/auth/me` and keeps one socket per
 *   `coreId` (a newer socket from the same user replaces the older; a different user is refused).
 * - A phone uses `https://<relay>/c/<coreId>/<path>` for HTTP and `wss://<relay>/c/<coreId>/ws`
 *   for the event stream. Its device token travels untouched in `Authorization`; the daemon
 *   enforces it. The relay only checks that a daemon is connected (else 503) and rate-limits by
 *   source address.
 *
 * Frames are in `./protocol`. Streaming HTTP responses are not proxied (one `resp` per `open`);
 * clients use the WebSocket for events.
 */
import type { Server, ServerWebSocket } from "bun";
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
  log?: (level: "info" | "warn", msg: string, data?: Record<string, unknown>) => void;
}

export interface RelayServer {
  port: number;
  url: string;
  daemons(): Array<{ coreId: string; userId: string; connectedAt: number; clients: number }>;
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

type DaemonData = { role: "daemon"; coreId: string; userId: string; conn: DaemonConn | null };
type ClientData = {
  role: "client";
  coreId: string;
  sid: string;
  path: string;
  headers: Record<string, string>;
  daemon: DaemonConn | null;
};
type WsData = DaemonData | ClientData;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Close codes the relay uses on client sockets; 4xxx is the application range. */
export const CLOSE_CORE_OFFLINE = 4503;
export const CLOSE_REPLACED = 4000;

export function startRelay(opts: RelayOptions): RelayServer {
  const fetchImpl: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const apiOrigin = opts.apiOrigin.replace(/\/+$/, "");
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
  const log =
    opts.log ??
    ((level, msg, data) =>
      console[level === "warn" ? "warn" : "log"](`[relay] ${msg}`, data ?? ""));
  const limiter =
    opts.rateLimit === false
      ? null
      : new RateLimiter(opts.rateLimit?.capacity ?? 120, opts.rateLimit?.perSecond ?? 20);
  const daemons = new Map<string, DaemonConn>();

  /** `GET /v1/auth/me` with the daemon's bearer; the subject is what identifies the owner. */
  const verifyBearer = async (bearer: string): Promise<string | null> => {
    const res = await fetchImpl(`${apiOrigin}/v1/auth/me`, {
      headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },
    });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`auth check failed: ${res.status}`);
    const body = (await res.json()) as { user?: { subject?: unknown } | null };
    const subject = body.user?.subject;
    return typeof subject === "string" && subject ? subject : null;
  };

  const send = (ws: ServerWebSocket<WsData>, frame: RelayToDaemon) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(frame));
  };

  const handleDaemon = async (
    req: Request,
    server: Server,
    url: URL,
  ): Promise<Response | undefined> => {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return json(426, { error: "websocket required" });
    const coreId = url.searchParams.get("coreId") ?? "";
    if (!CORE_ID_RE.test(coreId)) return json(400, { error: "bad coreId" });
    const bearer = req.headers
      .get("authorization")
      ?.replace(/^Bearer\s+/i, "")
      .trim();
    if (!bearer) return json(401, { error: "bearer required" });
    let userId: string | null;
    try {
      userId = await verifyBearer(bearer);
    } catch (e) {
      log("warn", "auth check unavailable", { error: e instanceof Error ? e.message : String(e) });
      return json(502, { error: "auth unavailable" });
    }
    if (!userId) return json(401, { error: "invalid session" });
    const existing = daemons.get(coreId);
    if (existing && existing.userId !== userId)
      return json(409, { error: "coreId owned by another user" });
    const data: DaemonData = { role: "daemon", coreId, userId, conn: null };
    if (server.upgrade(req, { data })) return undefined;
    return json(400, { error: "upgrade failed" });
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
      if (!limiter.take(ip)) return json(429, { error: "rate limited" });
    }
    if (!CORE_ID_RE.test(coreId)) return json(404, { error: "not found" });
    const daemon = daemons.get(coreId);
    if (!daemon) return json(503, { error: "core offline" });
    const path = rest + url.search;
    const sid = crypto.randomUUID();

    if (rest === "/ws" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const headers: Record<string, string> = {};
      const auth = req.headers.get("authorization");
      if (auth) headers["authorization"] = auth;
      const data: ClientData = { role: "client", coreId, sid, path, headers, daemon: null };
      if (server.upgrade(req, { data })) return undefined;
      return json(400, { error: "upgrade failed" });
    }

    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > maxBody) return json(413, { error: "body too large" });
    let body: Uint8Array | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = new Uint8Array(await req.arrayBuffer());
      if (body.byteLength > maxBody) return json(413, { error: "body too large" });
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
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        daemon.pending.delete(sid);
        resolve(json(504, { error: "core timed out" }));
      }, requestTimeoutMs);
      daemon.pending.set(sid, { resolve, timer });
      send(daemon.ws, frame);
    });
  };

  const server = Bun.serve<WsData, Record<never, never>>({
    hostname: opts.hostname ?? "0.0.0.0",
    port: opts.port ?? 4040,
    idleTimeout: 255,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return json(200, { ok: true, daemons: daemons.size });
      if (url.pathname === "/d") return handleDaemon(req, srv, url);
      const m = /^\/c\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (m) return handleClient(req, srv, url, m[1]!, m[2] ?? "/");
      return json(404, { error: "not found" });
    },
    websocket: {
      // The largest legitimate frame is a 4 MB body as base64 plus headers.
      maxPayloadLength: 8 * 1024 * 1024,
      open(ws) {
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
          if (old) {
            log("info", "daemon replaced", { coreId: conn.coreId });
            old.ws.close(CLOSE_REPLACED, "replaced by a newer connection");
          } else log("info", "daemon connected", { coreId: conn.coreId });
          return;
        }
        const daemon = daemons.get(ws.data.coreId);
        if (!daemon) {
          ws.close(CLOSE_CORE_OFFLINE, "core offline");
          return;
        }
        ws.data.daemon = daemon;
        daemon.clients.set(ws.data.sid, ws);
        send(daemon.ws, {
          t: "ws-open",
          sid: ws.data.sid,
          path: ws.data.path,
          headers: ws.data.headers,
        });
      },
      message(ws, raw) {
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
        if (ws.data.role === "client") {
          const daemon = ws.data.daemon;
          if (daemon) send(daemon.ws, { t: "ws-msg", sid: ws.data.sid, data: text });
          return;
        }
        const conn = ws.data.conn;
        if (!conn) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return;
        }
        const frame = DaemonToRelay.safeParse(parsed);
        if (!frame.success) {
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
          conn.clients.get(f.sid)?.send(f.data);
        } else {
          const client = conn.clients.get(f.sid);
          if (client) {
            conn.clients.delete(f.sid);
            client.close(f.code ?? 1000, f.reason ?? "");
          }
        }
      },
      close(ws) {
        if (ws.data.role === "client") {
          const daemon = ws.data.daemon;
          if (daemon && daemon.clients.delete(ws.data.sid))
            send(daemon.ws, { t: "close", sid: ws.data.sid });
          return;
        }
        const conn = ws.data.conn;
        if (!conn) return;
        for (const [, p] of conn.pending) {
          clearTimeout(p.timer);
          p.resolve(json(502, { error: "core disconnected" }));
        }
        conn.pending.clear();
        for (const [, client] of conn.clients)
          client.close(CLOSE_CORE_OFFLINE, "core disconnected");
        conn.clients.clear();
        if (daemons.get(conn.coreId) === conn) {
          daemons.delete(conn.coreId);
          log("info", "daemon disconnected", { coreId: conn.coreId });
        }
      },
    },
  });

  const port = server.port ?? opts.port ?? 4040;
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
    stop: () => server.stop(true),
  };
}
