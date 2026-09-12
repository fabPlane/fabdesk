/**
 * How a client reaches a core. `DirectTransport` talks straight to a daemon's remote listener
 * over a tailnet or LAN; `ProxyTransport` goes through a relay (`apps/relay`) the daemon dialled
 * out to, for a phone on cellular. Nothing above a transport (screens, queries, the event
 * reducer) knows the difference: a transport owns the base URL, the credential and how the
 * event stream is opened.
 */
import type { CoreEvent } from "@fabdesk/protocol";
import { CoreClient } from "./CoreClient";
import type { SseStatus, SseSubscription } from "./sse";
import { subscribeWs, type WebSocketFactory } from "./ws";

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

  constructor(opts: ProxyTransportOptions) {
    this.id = opts.id;
    this.relayUrl = opts.relayUrl.replace(/\/+$/, "");
    this.coreId = opts.coreId;
    this.inner = new DirectTransport({
      id: opts.id,
      baseUrl: relayBaseUrl(opts.relayUrl, opts.coreId),
      token: opts.token,
      ...(opts.webSocketFactory ? { webSocketFactory: opts.webSocketFactory } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
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
