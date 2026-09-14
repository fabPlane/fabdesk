/**
 * Which connection transitions are worth a Sentry event. `CoreConnection.tsx` reports every
 * phase/stream change; most are noise (a phone backgrounding drops the socket, a laptop asleep is
 * unreachable) and a monitored project full of those hides the real failures. Kept pure so Bun
 * can test the policy; `src/observability.ts` does the reporting.
 */
import type { AppStateLike, StreamStatus } from "./reconnect";

/** `ConnectionPhase` from CoreConnection.tsx, spelled out so this file needs no RN imports. */
export type PhaseLike =
  | "idle"
  | "locating"
  | "connecting"
  | "ready"
  | "unreachable"
  | "core-offline"
  | "unauthorized";

export interface ConnectionSnapshot {
  phase: PhaseLike;
  status: StreamStatus;
  /** The provider's error text, when the phase carries one. */
  error: string | null;
  app: AppStateLike;
}

export interface TransportFailure {
  /** Stable key for de-duplication and the Sentry fingerprint. */
  key: "unreachable" | "unauthorized" | "stream-dropped";
  message: string;
  level: "warning" | "error";
}
/** The same failure is not worth repeating more often than this (ms). */
export const FAILURE_DEDUPE_MS = 5 * 60_000;

/**
 * The failure a transition represents, or null. Only three things qualify:
 * - locating ended with no address answering (`unreachable`) — the daemon may be off, but a
 *   pattern of these across devices is how a broken pairing-URL change would show up;
 * - the stored device token was rejected (`unauthorized`) — never expected without a revoke;
 * - an open stream dropped while the app was in the foreground — a backgrounded phone losing its
 *   socket is the OS, not a bug.
 * `core-offline` — the relay answered that the computer is not dialled in — is deliberately not
 * one: a laptop asleep or shut is the user's business, and the relay's verdict is unambiguous.
 */
export function transportFailure(
  prev: ConnectionSnapshot | null,
  next: ConnectionSnapshot,
): TransportFailure | null {
  if (next.phase === "unreachable" && prev?.phase !== "unreachable") {
    return {
      key: "unreachable",
      message: next.error ?? "No saved address answered",
      level: "warning",
    };
  }
  if (next.phase === "unauthorized" && prev?.phase !== "unauthorized") {
    return {
      key: "unauthorized",
      message: next.error ?? "Device token rejected",
      level: "error",
    };
  }
  if (
    prev?.status === "open" &&
    (next.status === "reconnecting" || next.status === "closed") &&
    next.app === "active" &&
    prev.app === "active"
  ) {
    return {
      key: "stream-dropped",
      message: `Event stream dropped while in the foreground (${next.status})`,
      level: "warning",
    };
  }
  return null;
}

/**
 * Remembers when each failure key was last reported so a flapping network does not produce a
 * burst. `shouldReport` both answers and records.
 */
export function createFailureDeduper(windowMs = FAILURE_DEDUPE_MS) {
  const last = new Map<TransportFailure["key"], number>();
  return {
    shouldReport(f: TransportFailure, now: number): boolean {
      const at = last.get(f.key);
      if (at !== undefined && now - at < windowMs) return false;
      last.set(f.key, now);
      return true;
    },
  };
}
