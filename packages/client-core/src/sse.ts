/**
 * Reconnecting SSE subscription over an injectable EventSource so the logic is unit-testable.
 *
 * Native EventSource reconnects on transient errors and sends `Last-Event-ID` itself, but it gives
 * up (readyState CLOSED) on non-2xx responses and when the daemon restarts on a new port. This
 * wrapper re-creates the source with exponential backoff and forwards the last id in the query
 * string as well, so a fresh connection can resume even where the header is dropped.
 */
import type { CoreEvent } from "@fabdesk/protocol";

export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export type SseStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface SseOptions {
  /** Builds the URL for a (re)connection; `lastEventId` is the id of the last event seen. */
  buildUrl: (lastEventId: string | null) => string;
  factory: EventSourceFactory;
  onEvent: (event: CoreEvent, id: string) => void;
  onStatus?: (status: SseStatus, attempt: number) => void;
  /** Injectable timer for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Source of backoff jitter, `Math.random` by default; tests inject a constant. */
  random?: () => number;
}

export interface SseSubscription {
  close(): void;
  readonly lastEventId: string | null;
  readonly status: SseStatus;
  readonly attempt: number;
}

export const EVENT_SOURCE_CLOSED = 2;

/**
 * Exponential backoff, capped. With `random` supplied the delay is jittered down by up to half —
 * every phone that lost the same Wi-Fi would otherwise dial the daemon in lockstep — so the result
 * lies in `[delay / 2, delay]`; the un-jittered value is the upper bound, never exceeded.
 */
export function reconnectDelay(
  attempt: number,
  base = 1000,
  max = 15000,
  random?: () => number,
): number {
  const delay = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  if (!random) return delay;
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(delay * (1 - 0.5 * r));
}

export function appendLastEventId(url: string, lastEventId: string | null): string {
  if (lastEventId === null) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}lastEventId=${encodeURIComponent(lastEventId)}`;
}

export function parseCoreEvent(data: string): CoreEvent | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { topic?: unknown }).topic === "string"
    ) {
      return parsed as CoreEvent;
    }
    return null;
  } catch {
    return null;
  }
}

export function subscribeSse(options: SseOptions): SseSubscription {
  const setT = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearT =
    options.clearTimeout ??
    ((h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>));
  const random = options.random ?? Math.random;
  let source: EventSourceLike | null = null;
  let lastEventId: string | null = null;
  let status: SseStatus = "connecting";
  let attempt = 0;
  let closed = false;
  let timer: unknown = null;

  const setStatus = (next: SseStatus) => {
    status = next;
    options.onStatus?.(next, attempt);
  };

  const connect = () => {
    if (closed) return;
    const es = options.factory(appendLastEventId(options.buildUrl(lastEventId), lastEventId));
    source = es;
    es.onopen = () => {
      attempt = 0;
      setStatus("open");
    };
    es.onmessage = (ev) => {
      if (ev.lastEventId) lastEventId = ev.lastEventId;
      const event = parseCoreEvent(ev.data);
      if (event) options.onEvent(event, ev.lastEventId);
    };
    es.onerror = () => {
      if (closed) return;
      if (es.readyState === EVENT_SOURCE_CLOSED) {
        // Native retry is over; take over with our own backoff.
        es.close();
        if (source === es) source = null;
        attempt += 1;
        setStatus("reconnecting");
        timer = setT(
          connect,
          reconnectDelay(attempt, options.baseDelayMs, options.maxDelayMs, random),
        );
      } else {
        setStatus("reconnecting");
      }
    };
  };

  connect();

  return {
    close() {
      closed = true;
      if (timer !== null) clearT(timer);
      source?.close();
      source = null;
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
