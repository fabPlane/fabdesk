/**
 * How a client reaches a core. `DirectTransport` talks straight to a daemon's remote listener
 * over a tailnet or LAN; `ProxyTransport` goes through a relay (`apps/relay`) the daemon dialled
 * out to, for a phone on cellular. Nothing above a transport (screens, queries, the event
 * reducer) knows the difference: a transport owns the base URL, the credential and how the
 * event stream is opened.
 */
import type { CoreEvent } from "@fabdesk/protocol";
import { CoreClient, CoreHttpError, type FetchLike } from "./CoreClient";
import type { SseStatus, SseSubscription } from "./sse";
import { subscribeWs, type WebSocketFactory, type WebSocketLike } from "./ws";

export type TransportKind = "direct" | "proxy";

export interface EventStreamOptions {
  topics: string[];
  onEvent: (event: CoreEvent, id: string) => void;
  onStatus?: (status: SseStatus, attempt: number) => void;
  /** False drops the resume cursor; the daemon's event ids restart at 0 when it does. */
  canResume?: () => boolean | Promise<boolean>;
}

export interface CoreTransport {
  readonly id: string;
  readonly kind: TransportKind;
  baseUrl(): string;
  authHeaders(): Record<string, string>;
  client(): CoreClient;
  openEvents(opts: EventStreamOptions): SseSubscription;
  dispose(): void;
}

export interface DirectTransportOptions {
  id: string;
  baseUrl: string;
  token: string;
  /** `globalThis.WebSocket` by default; injectable for tests. */
  webSocketFactory?: WebSocketFactory;
  fetch?: ConstructorParameters<typeof CoreClient>[0]["fetch"];
}

/** Plain HTTP + `/ws` against one reachable daemon. No relay, no tunnel. */
export class DirectTransport implements CoreTransport {
  readonly id: string;
  readonly kind = "direct" as const;
  private readonly url: string;
  private readonly token: string;
  private readonly wsFactory: WebSocketFactory;
  private readonly core: CoreClient;
  private subscriptions = new Set<SseSubscription>();

  constructor(opts: DirectTransportOptions) {
    this.id = opts.id;
    this.url = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token;
    this.wsFactory =
      opts.webSocketFactory ??
      ((url) => new globalThis.WebSocket(url) as unknown as ReturnType<WebSocketFactory>);
    this.core = new CoreClient({
      baseUrl: this.url,
      token: this.token,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  baseUrl(): string {
    return this.url;
  }

  authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  client(): CoreClient {
    return this.core;
  }

  openEvents(opts: EventStreamOptions): SseSubscription {
    const sub = subscribeWs({
      buildUrl: () => {
        const scheme = this.url.startsWith("https:") ? "wss:" : "ws:";
        const rest = this.url.replace(/^https?:/, "");
        const topics = encodeURIComponent(opts.topics.join(","));
        return `${scheme}${rest}/ws?topics=${topics}&token=${encodeURIComponent(this.token)}`;
      },
      topics: opts.topics,
      factory: this.wsFactory,
      onEvent: opts.onEvent,
      ...(opts.onStatus ? { onStatus: opts.onStatus } : {}),
      ...(opts.canResume ? { canResume: opts.canResume } : {}),
    });
    this.subscriptions.add(sub);
    return sub;
  }

  dispose(): void {
    for (const sub of this.subscriptions) sub.close();
    this.subscriptions.clear();
  }
}

export interface ProxyTransportOptions {
  id: string;
  /** The relay's origin, e.g. `https://relay.fabplane.com`; a path prefix is kept. */
  relayUrl: string;
  /** The daemon's stable identity (`/health` → `coreId`), which names it on the relay. */
  coreId: string;
  /** The device token, sent exactly as to a direct listener; the relay forwards it unchecked. */
  token: string;
  webSocketFactory?: WebSocketFactory;
  fetch?: ConstructorParameters<typeof CoreClient>[0]["fetch"];
  /**
   * Fires when the relay's verdict on the daemon changes: `offline` on a `503 core offline` (or
   * the event socket closing with `4503`), `online` on the next answer that came from the daemon.
   * A phone turns `offline` into "your computer is not connected" instead of "unreachable".
   */
  onCoreState?: (state: RelayCoreState) => void;
}

/** What the relay last said about the daemon this transport proxies to. */
export type RelayCoreState = "online" | "offline";

/** The relay's close code on a phone socket when no daemon is dialled in (`apps/relay`'s `CLOSE_CORE_OFFLINE`). */
export const RELAY_CLOSE_CORE_OFFLINE = 4503;

/**
 * Whether a response is the relay saying the daemon is not there — `503 {error:"core offline"}`
 * when nothing is dialled in, `502 {error:"core disconnected"}` when it dropped mid-request — as
 * opposed to a 503 the daemon itself produced, which passes through untouched.
 */
export function relaySaysCoreOffline(status: number, body: unknown): boolean {
  if (status !== 503 && status !== 502) return false;
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return false;
    }
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  return error === "core offline" || error === "core disconnected";
}

/** Thrown by a `ProxyTransport` request when the relay answered for an absent daemon. */
export class CoreOfflineError extends CoreHttpError {
  constructor(status: number, path: string) {
    super(status, path, "core offline: the relay is up, but your computer is not connected to it");
    this.name = "CoreOfflineError";
  }
}

export function isCoreOffline(e: unknown): e is CoreOfflineError {
  return e instanceof CoreOfflineError;
}

/**
 * A socket whose open and close are observed before the subscriber's own handlers run.
 * `subscribeWs` assigns each handler once per socket; the wrapper keeps that contract and only
 * peeks at the close code.
 */
function observeSocket(
  ws: WebSocketLike,
  hooks: { onOpen: () => void; onClose: (ev: unknown) => void },
): WebSocketLike {
  return {
    get onopen() {
      return ws.onopen;
    },
    set onopen(handler) {
      ws.onopen = handler
        ? (ev) => {
            hooks.onOpen();
            handler(ev);
          }
        : null;
    },
    get onerror() {
      return ws.onerror;
    },
    set onerror(handler) {
      ws.onerror = handler;
    },
    get onclose() {
      return ws.onclose;
    },
    set onclose(handler) {
      ws.onclose = (ev) => {
        hooks.onClose(ev);
        handler?.(ev);
      };
    },
    get onmessage() {
      return ws.onmessage;
    },
    set onmessage(handler) {
      ws.onmessage = handler;
    },
    send: (data) => ws.send(data),
    close: () => ws.close(),
  };
}

/** Everything a phone says to `<relay>/c/<coreId>/…` is `/…` on the daemon, so use one base URL. */
export function relayBaseUrl(relayUrl: string, coreId: string): string {
  return `${relayUrl.replace(/\/+$/, "")}/c/${encodeURIComponent(coreId)}`;
}

/**
 * HTTP and `/ws` through a relay. The relay proxies `/c/<coreId>/<path>` to the daemon's remote
 * app and `/c/<coreId>/ws` to its event socket, so this is a `DirectTransport` whose base URL
 * carries the prefix — the same `subscribeWs`, the same auth header.
 */
export class ProxyTransport implements CoreTransport {
  readonly id: string;
  readonly kind = "proxy" as const;
  readonly relayUrl: string;
  readonly coreId: string;
  private readonly inner: DirectTransport;
  private readonly onCoreState: ((state: RelayCoreState) => void) | undefined;
  private coreState: RelayCoreState = "online";

  constructor(opts: ProxyTransportOptions) {
    this.id = opts.id;
    this.relayUrl = opts.relayUrl.replace(/\/+$/, "");
    this.coreId = opts.coreId;
    this.onCoreState = opts.onCoreState;
    const prefix = relayBaseUrl(opts.relayUrl, opts.coreId);
    const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    // A `503 core offline` is the relay's, not the daemon's: it becomes a distinct error rather
    // than the generic `CoreHttpError`, so a screen can say which of the two is missing.
    const fetch: FetchLike = async (input, init) => {
      const res = await doFetch(input, init);
      if (res.status === 503 || res.status === 502) {
        const text = await res
          .clone()
          .text()
          .catch(() => "");
        if (relaySaysCoreOffline(res.status, text)) {
          this.setCoreState("offline");
          throw new CoreOfflineError(res.status, input.slice(prefix.length) || "/");
        }
      }
      this.setCoreState("online");
      return res;
    };
    const makeSocket =
      opts.webSocketFactory ??
      ((url) => new globalThis.WebSocket(url) as unknown as ReturnType<WebSocketFactory>);
    const webSocketFactory: WebSocketFactory = (url) =>
      observeSocket(makeSocket(url), {
        onOpen: () => this.setCoreState("online"),
        onClose: (ev) => {
          if ((ev as { code?: unknown } | null)?.code === RELAY_CLOSE_CORE_OFFLINE)
            this.setCoreState("offline");
        },
      });
    this.inner = new DirectTransport({
      id: opts.id,
      baseUrl: prefix,
      token: opts.token,
      webSocketFactory,
      fetch,
    });
  }

  /** True after the relay last answered that no daemon is connected for `coreId`. */
  get coreOffline(): boolean {
    return this.coreState === "offline";
  }

  private setCoreState(next: RelayCoreState) {
    if (this.coreState === next) return;
    this.coreState = next;
    this.onCoreState?.(next);
  }

  baseUrl(): string {
    return this.inner.baseUrl();
  }

  authHeaders(): Record<string, string> {
    return this.inner.authHeaders();
  }

  client(): CoreClient {
    return this.inner.client();
  }

  openEvents(opts: EventStreamOptions): SseSubscription {
    return this.inner.openEvents(opts);
  }

  dispose(): void {
    this.inner.dispose();
  }
}
