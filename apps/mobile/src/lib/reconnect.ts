/**
 * The decisions behind keeping a phone's connection alive across backgrounding and network
 * hand-offs, kept pure so Bun can test them. `CoreConnection.tsx` owns the listeners (AppState,
 * expo-network) and the transport; this file only says what to do with what they report.
 */

/** The subset of `SseStatus` that matters here, spelled out so this file needs no imports. */
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/** The subset of React Native's `AppStateStatus` that matters here. */
export type AppStateLike = "active" | "background" | "inactive" | "unknown" | "extension";

/** The subset of expo-network's `NetworkState` that matters here. */
export interface NetworkStateLike {
  type?: string | undefined;
  isConnected?: boolean | undefined;
  isInternetReachable?: boolean | undefined;
}

/**
 * When the stream last left `open`, or null while it is open or has never been. A stream that was
 * never open is "still connecting", not "stale" — the Chats screen should not say "reconnecting
 * for 30 s" on a cold start.
 */
export function nextStaleSince(
  prevStatus: StreamStatus | null,
  nextStatus: StreamStatus,
  staleSince: number | null,
  now: number,
): number | null {
  if (nextStatus === "open") return null;
  if (prevStatus === "open") return now;
  return staleSince;
}

/** Coming back to the foreground: iOS reports `inactive` on the way out and in, so any non-active → active counts. */
export function isForegroundReturn(prev: AppStateLike | null, next: AppStateLike): boolean {
  return next === "active" && prev !== null && prev !== "active";
}

/**
 * A network event worth re-probing on: the phone is connected (or the module cannot say) and the
 * link actually changed. Wi-Fi → cellular changes `type`; airplane mode toggles `isConnected`;
 * a captive portal clearing flips `isInternetReachable`. Losing the network is not worth a probe —
 * every candidate would time out — the stream's own backoff covers the wait.
 */
export function shouldReprobeOnNetwork(
  prev: NetworkStateLike | null,
  next: NetworkStateLike,
): boolean {
  if (next.isConnected === false) return false;
  if (prev === null) return true;
  return (
    prev.type !== next.type ||
    prev.isConnected !== next.isConnected ||
    (prev.isInternetReachable === false && next.isInternetReachable !== false)
  );
}

export type ReprobeOutcome =
  /** The socket is alive on the address that answered; nothing to do. */
  | { kind: "keep" }
  /** Same address, but the stream is not open: dial again now rather than waiting out the backoff. */
  | { kind: "reopen" }
  /** A different address answered — the laptop (or the phone) moved networks. */
  | { kind: "switch"; baseUrl: string }
  /** Nothing answers and there is no transport to lean on: start locating from scratch. */
  | { kind: "relocate" };

/**
 * What to do with a re-probe's result. `found` is the address that answered (`null` if none),
 * `currentBaseUrl` the one the transport is on (`null` before one exists).
 */
export function planAfterReprobe(input: {
  found: string | null;
  currentBaseUrl: string | null;
  streamStatus: StreamStatus;
}): ReprobeOutcome {
  const { found, currentBaseUrl, streamStatus } = input;
  if (currentBaseUrl === null) return { kind: "relocate" };
  if (found !== null && found !== currentBaseUrl) return { kind: "switch", baseUrl: found };
  if (streamStatus === "open") return { kind: "keep" };
  // No answer and the stream is down: still dial. The probe may have raced the network coming up,
  // and a failed dial restarts the backoff at one second instead of leaving a fifteen-second wait.
  return { kind: "reopen" };
}
