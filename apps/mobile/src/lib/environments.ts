/**
 * Several paired computers ("environments"): which is reachable, and in what order to list them.
 * Pure — the probing itself, the store and the screens are in `transport/CoreConnection` and
 * `components/EnvironmentSwitcher`; this is what they agree on.
 *
 * Status comes from a `/health` probe of each saved computer's last-known addresses, kept in
 * memory only: it is a snapshot of the network as of a minute ago, worthless across a launch.
 */
import { relativeTime } from "./format";

export type EnvironmentStatus = "unknown" | "reachable" | "offline";

export interface StatusEntry {
  status: EnvironmentStatus;
  /** When the probe that produced `status` finished (ms since epoch); null before the first. */
  checkedAt: number | null;
  /** The address that answered, when one did — the best first guess on the next switch. */
  baseUrl: string | null;
}

export const UNKNOWN_STATUS: StatusEntry = { status: "unknown", checkedAt: null, baseUrl: null };

/** How often every saved computer is probed while a screen that shows status is on screen. */
export const STATUS_PROBE_INTERVAL_MS = 60_000;

/**
 * A screen mounting right after another that probed (the switcher sheet over the Connections
 * screen) should not fire a fresh round; anything younger than this is served from the snapshot.
 */
export const STATUS_FRESH_MS = 10_000;

export interface EnvironmentLike {
  id: string;
  baseUrl: string;
  candidates: string[];
  pairedAt: string;
  lastConnectedAt: string | null;
}

/** Turns a probe outcome into an entry; `found` is the address that answered, or null. */
export function statusFromProbe(found: string | null, now: number): StatusEntry {
  return found
    ? { status: "reachable", checkedAt: now, baseUrl: found }
    : { status: "offline", checkedAt: now, baseUrl: null };
}

/** Whether a fresh round is worth running, given when the oldest entry was last checked. */
export function probeDue(
  statuses: Record<string, StatusEntry>,
  ids: readonly string[],
  now: number,
  freshMs = STATUS_FRESH_MS,
): boolean {
  if (ids.length === 0) return false;
  return ids.some((id) => {
    const at = statuses[id]?.checkedAt;
    return at === null || at === undefined || now - at >= freshMs;
  });
}

/**
 * Probes every computer in parallel with an injectable prober and returns one entry per id.
 * Parallel rather than sequential: a sleeping laptop otherwise costs a full timeout before the
 * next one is looked at, and there is no one-time token to burn here.
 */
export async function probeEnvironments<E extends EnvironmentLike>(
  environments: readonly E[],
  prober: (env: E) => Promise<string | null>,
  now: () => number = Date.now,
): Promise<Record<string, StatusEntry>> {
  const entries = await Promise.all(
    environments.map(async (env) => {
      const found = await prober(env).catch(() => null);
      return [env.id, statusFromProbe(found, now())] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * The status the UI shows for the active computer: the live stream knows better than a probe from
 * up to a minute ago. An open stream is proof of reachability; a locate that failed is proof of
 * the opposite; anything in between (connecting, reconnecting) falls back to the probe.
 */
export function effectiveStatus(
  entry: StatusEntry | undefined,
  live: { streamOpen: boolean; unreachable: boolean } | null,
): EnvironmentStatus {
  if (live?.streamOpen) return "reachable";
  if (live?.unreachable) return "offline";
  return entry?.status ?? "unknown";
}

const STATUS_RANK: Record<EnvironmentStatus, number> = { reachable: 0, unknown: 1, offline: 2 };

/**
 * Listing order for the switcher and the Connections screen: the active computer first, then the
 * reachable ones, then by when each was last seen (most recent first; never-connected last, by
 * pairing time). Stable for equal keys, so the list does not shuffle between probes.
 */
export function orderEnvironments<E extends EnvironmentLike>(
  environments: readonly E[],
  activeId: string | null,
  statusOf: (id: string) => EnvironmentStatus,
): E[] {
  const seen = (e: E) => Date.parse(e.lastConnectedAt ?? "") || 0;
  const paired = (e: E) => Date.parse(e.pairedAt) || 0;
  return environments
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const activeDiff = Number(b.e.id === activeId) - Number(a.e.id === activeId);
      if (activeDiff) return activeDiff;
      const statusDiff = STATUS_RANK[statusOf(a.e.id)] - STATUS_RANK[statusOf(b.e.id)];
      if (statusDiff) return statusDiff;
      return seen(b.e) - seen(a.e) || paired(b.e) - paired(a.e) || a.i - b.i;
    })
    .map(({ e }) => e);
}

export const statusLabel: Record<EnvironmentStatus, string> = {
  reachable: "Online",
  offline: "Offline",
  unknown: "Checking…",
};

/**
 * "last seen" for a row. A reachable probe counts as being seen even though nothing connected —
 * the phrase is about the computer, not the socket — so it is the later of the two timestamps.
 */
export function lastSeenLabel(
  env: { lastConnectedAt: string | null },
  entry: StatusEntry | undefined,
  now: number = Date.now(),
): string {
  const seenAt = Math.max(
    Date.parse(env.lastConnectedAt ?? "") || 0,
    entry?.status === "reachable" && entry.checkedAt ? entry.checkedAt : 0,
  );
  if (!seenAt) return "never connected";
  return `last seen ${relativeTime(new Date(seenAt).toISOString(), now)}`;
}
