/**
 * Picking a working address for a saved connection.
 *
 * A paired laptop moves: a tailnet address today, a LAN address tomorrow, neither while it is
 * asleep. `/health` is the cheapest probe the daemon has and needs no token, so every candidate is
 * raced against it and the first to answer wins.
 */
export interface HealthInfo {
  ok: boolean;
  version: string;
  pid: number;
  channel: string;
  authMode: string;
  uptimeMs: number;
  /** Stable daemon identity (docs/mobile-notifications.md §4.4); absent on daemons that predate it. */
  coreId?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ProbeOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Injectable timers for tests, as in client-core's stream wrappers. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export async function probe(baseUrl: string, opts: ProbeOptions = {}): Promise<HealthInfo | null> {
  const doFetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const setT = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT =
    opts.clearTimeout ??
    ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const controller = new AbortController();
  const timer = setT(() => controller.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as HealthInfo;
    return body.ok ? body : null;
  } catch {
    return null;
  } finally {
    clearT(timer);
  }
}

export interface Reachable {
  baseUrl: string;
  health: HealthInfo;
  /** `relay` when the address is the relay's `/c/<coreId>` prefix — build a `ProxyTransport`, not a `DirectTransport`. */
  via: "direct" | "relay";
}

/** The relay a saved connection can fall back to; both halves are known only once paired with a daemon that has a `coreId`. */
export interface RelayTarget {
  url: string;
  coreId: string;
}

export interface FindOptions extends ProbeOptions {
  /** Tried after every direct address has failed: the relay proxies `/health` to the daemon, so a 503 means it is off. */
  relay?: RelayTarget | null;
}

/** Where a relay serves one daemon: `<relay>/c/<coreId>`, the same base URL `ProxyTransport` uses. */
export function relayBaseUrl(relay: RelayTarget): string {
  return `${relay.url.replace(/\/+$/, "")}/c/${encodeURIComponent(relay.coreId)}`;
}

/**
 * The relay endpoint a pairing payload carries, if any, as a URL. Read leniently: `kinds`/`schemes`
 * ride as parallel lists next to `hosts` and older daemons send neither; a relay host is
 * `hostname[:port]` and defaults to https.
 */
export function relayUrlFromPayload(payload: {
  hosts: string[];
  kinds?: readonly string[] | undefined;
  schemes?: readonly string[] | undefined;
}): string | null {
  const kinds = payload.kinds;
  if (!kinds || kinds.length !== payload.hosts.length) return null;
  const i = kinds.indexOf("relay");
  const host = i >= 0 ? payload.hosts[i] : undefined;
  if (!host) return null;
  const scheme = payload.schemes?.[i] === "http" ? "http" : "https";
  return `${scheme}://${host}`;
}

/**
 * The first address that answers. Probes run in parallel — unlike claiming a pairing code there is
 * nothing to burn, and a sleeping address otherwise costs a full timeout before the next is tried.
 * The relay is tried only after every direct address has failed: it is reachable from anywhere,
 * so it would otherwise win every race against a tailnet address and add a hop for nothing.
 */
export async function findReachable(
  baseUrls: string[],
  opts: FindOptions = {},
): Promise<Reachable | null> {
  const relay = opts.relay ? relayBaseUrl(opts.relay) : null;
  const direct = baseUrls.filter((u) => u !== relay);
  if (direct.length > 0) {
    const results = await Promise.all(
      direct.map(async (baseUrl) => ({ baseUrl, health: await probe(baseUrl, opts) })),
    );
    for (const r of results) {
      if (r.health) return { baseUrl: r.baseUrl, health: r.health, via: "direct" };
    }
  }
  if (!relay) return null;
  const health = await probe(relay, opts);
  return health ? { baseUrl: relay, health, via: "relay" } : null;
}
