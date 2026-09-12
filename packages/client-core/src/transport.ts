/**
 * How a client reaches a core. v1 ships `DirectTransport` only — the phone talks straight to a
 * daemon's remote listener over a tailnet or LAN. A hosted relay is the next implementation of
 * this interface, and nothing above it (screens, queries, the event reducer) has to change:
 * a transport owns the base URL, the credential and how the event stream is opened.
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
