/**
 * Picking a working address for a saved connection.
 *
 * A paired laptop moves: a tailnet address today, a LAN address tomorrow, neither while it is
 * asleep. `/health` is the cheapest probe the daemon has and needs no token, so every candidate is
 * raced against it and the first to answer wins.
 */
import { relaySaysCoreOffline } from "@fabdesk/client-core";

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

/**
 * What one `/health` probe found. `core-offline` is the relay answering for an absent daemon
 * (`503 {error:"core offline"}`, or `502 {error:"core disconnected"}`): the relay is reachable,
 * the computer is not dialled in — worth telling the user apart from "nothing answered".
 */
export type ProbeOutcome =
  | { kind: "ok"; health: HealthInfo }
  | { kind: "core-offline" }
  | { kind: "unreachable" };

export async function probeOutcome(
  baseUrl: string,
  opts: ProbeOptions = {},
): Promise<ProbeOutcome> {
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
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return relaySaysCoreOffline(res.status, text)
        ? { kind: "core-offline" }
        : { kind: "unreachable" };
    }
    const body = (await res.json()) as HealthInfo;
    return body.ok ? { kind: "ok", health: body } : { kind: "unreachable" };
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearT(timer);
  }
}

export async function probe(baseUrl: string, opts: ProbeOptions = {}): Promise<HealthInfo | null> {
  const outcome = await probeOutcome(baseUrl, opts);
  return outcome.kind === "ok" ? outcome.health : null;
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
  return (await locate(baseUrls, opts)).found;
}

export interface Located {
  found: Reachable | null;
  /**
   * What the relay said when it was asked: `core-offline` is the one verdict worth a distinct
   * screen (the relay is up, the computer is not); `none` when there was no relay to ask, or a
   * direct address answered first.
   */
  relay: "answered" | "core-offline" | "unreachable" | "none";
}

/** `findReachable`, plus the relay's verdict when nothing direct answered. */
export async function locate(baseUrls: string[], opts: FindOptions = {}): Promise<Located> {
  const relay = opts.relay ? relayBaseUrl(opts.relay) : null;
  const direct = baseUrls.filter((u) => u !== relay);
  if (direct.length > 0) {
    const results = await Promise.all(
      direct.map(async (baseUrl) => ({ baseUrl, health: await probe(baseUrl, opts) })),
    );
    for (const r of results) {
      if (r.health)
        return { found: { baseUrl: r.baseUrl, health: r.health, via: "direct" }, relay: "none" };
    }
  }
  if (!relay) return { found: null, relay: "none" };
  const outcome = await probeOutcome(relay, opts);
  if (outcome.kind === "ok")
    return { found: { baseUrl: relay, health: outcome.health, via: "relay" }, relay: "answered" };
  return { found: null, relay: outcome.kind };
}
