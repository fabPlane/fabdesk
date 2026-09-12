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
  const clearT = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const controller = new AbortController();
  const timer = setT(() => controller.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await doFetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: controller.signal });
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
}

/**
 * The first address that answers. Probes run in parallel — unlike claiming a pairing code there is
 * nothing to burn, and a sleeping address otherwise costs a full timeout before the next is tried.
 */
export async function findReachable(baseUrls: string[], opts: ProbeOptions = {}): Promise<Reachable | null> {
  if (baseUrls.length === 0) return null;
  const results = await Promise.all(
    baseUrls.map(async (baseUrl) => ({ baseUrl, health: await probe(baseUrl, opts) })),
  );
  for (const r of results) {
    if (r.health) return { baseUrl: r.baseUrl, health: r.health };
  }
  return null;
}
