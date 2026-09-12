/**
 * Reconnecting WebSocket subscription to the daemon's `/ws` endpoint.
 *
 * The SSE stream (`/events`) is what the Electron renderer uses, but React Native has no
 * `EventSource` and its `fetch` cannot stream a response body, so the mobile client rides the
 * WebSocket instead. The daemon's protocol is: connect with `?topics=&token=`, then send
 * `{subscribe, lastEventId}` to (re)subscribe and replay everything after that id; each frame back
 * is a `{id, event}` envelope. Reconnect backoff is shared with the SSE wrapper.
 */
import type { CoreEvent } from "@fabdesk/protocol";
import { parseCoreEvent, reconnectDelay, type SseStatus, type SseSubscription } from "./sse";

export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WsOptions {
  /** Builds the socket URL; called fresh on every attempt so a rotated token is picked up. */
  buildUrl: () => string;
  topics: string[];
  factory: WebSocketFactory;
  onEvent: (event: CoreEvent, id: string) => void;
  onStatus?: (status: SseStatus, attempt: number) => void;
  /**
   * Called before each (re)connect. Returning `false` drops `lastEventId`, so the client refetches
   * instead of trusting replay — the daemon's ids restart at 0 whenever it does.
   */
  canResume?: () => boolean | Promise<boolean>;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Source of backoff jitter, `Math.random` by default; tests inject a constant. */
  random?: () => number;
}

/** One `{id, event}` frame off the wire, or null if it is not one. */
export function parseWsFrame(data: unknown): { id: number; event: CoreEvent } | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { id, event } = parsed as { id?: unknown; event?: unknown };
  if (typeof id !== "number" || !event || typeof event !== "object") return null;
  const core = parseCoreEvent(JSON.stringify(event));
  return core ? { id, event: core } : null;
}

export function subscribeWs(options: WsOptions): SseSubscription {
  const setT = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT =
    options.clearTimeout ??
    ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const random = options.random ?? Math.random;
  let socket: WebSocketLike | null = null;
  let lastEventId: string | null = null;
  let status: SseStatus = "connecting";
  let attempt = 0;
  let closed = false;
  let timer: unknown = null;

  const setStatus = (next: SseStatus) => {
    status = next;
    options.onStatus?.(next, attempt);
  };

  // A failed socket fires `onerror` and then `onclose`, so a retry has to be idempotent per
  // socket — otherwise every failure doubles the number of sockets being opened.
  const retried = new WeakSet<WebSocketLike>();

  const retry = (ws: WebSocketLike) => {
    if (closed || retried.has(ws)) return;
    retried.add(ws);
    ws.close();
    if (socket === ws) socket = null;
    attempt += 1;
    setStatus("reconnecting");
    timer = setT(connect, reconnectDelay(attempt, options.baseDelayMs, options.maxDelayMs, random));
  };

  const connect = () => {
    if (closed) return;
    const ws = options.factory(options.buildUrl());
    socket = ws;
    ws.onopen = () => {
      void (async () => {
        if (closed) return;
        // The daemon replays only the last 500 events per topic and resets its ids on restart,
        // so a host that knows it restarted tells us to start clean rather than silently skip.
        const resume = options.canResume ? await options.canResume() : true;
        if (!resume) lastEventId = null;
        attempt = 0;
        ws.send(
          JSON.stringify({
            subscribe: options.topics,
            ...(lastEventId !== null ? { lastEventId: Number(lastEventId) } : {}),
          }),
        );
        setStatus("open");
      })();
    };
    ws.onmessage = (ev) => {
      const frame = parseWsFrame(ev.data);
      if (!frame) return;
      lastEventId = String(frame.id);
      options.onEvent(frame.event, lastEventId);
    };
    ws.onerror = () => retry(ws);
    ws.onclose = () => retry(ws);
  };

  connect();

  return {
    close() {
      closed = true;
      if (timer !== null) clearT(timer);
      socket?.close();
      socket = null;
      setStatus("closed");
    },
    get lastEventId() {
      return lastEventId;
    },
    get status() {
      return status;
    },
    get attempt() {
      return attempt;
    },
  };
}
