/**
 * Event bus: validates every CoreEvent, keeps a per-topic ring buffer for SSE catch-up and fans out
 * to subscribers. `route.frame` attempt frames are coalesced per subscriber (one flush per ~33 ms);
 * structural events (pass-start, connection, pair, done, meta, static, route.done) are never dropped.
 */
import { CoreEvent, topicMatches } from "@fabdesk/protocol";
import { logger } from "./log";

export type StoredEvent = { id: number; event: CoreEvent };

export type Subscriber = {
  id: number;
  patterns: string[];
  /** Called with a batch of events in id order. */
  deliver: (events: StoredEvent[]) => void;
  coalesceMs: number;
  pending: StoredEvent[];
  timer: ReturnType<typeof setTimeout> | null;
};

export type BusOptions = { ringSize?: number; coalesceMs?: number; validate?: boolean };

export class EventBus {
  private seq = 0;
  private readonly rings = new Map<string, StoredEvent[]>();
  private readonly subs = new Map<number, Subscriber>();
  private nextSub = 1;
  private readonly ringSize: number;
  private readonly coalesceMs: number;
  private readonly validate: boolean;

  constructor(opts: BusOptions = {}) {
    this.ringSize = opts.ringSize ?? 500;
    this.coalesceMs = opts.coalesceMs ?? 33;
    this.validate = opts.validate ?? true;
  }

  get lastId(): number {
    return this.seq;
  }

  emit(event: CoreEvent): StoredEvent {
    if (this.validate) {
      const parsed = CoreEvent.safeParse(event);
      if (!parsed.success) {
        logger.error("bus: invalid event dropped", { topic: (event as { topic?: string }).topic, issue: parsed.error.issues[0]?.message });
        throw new Error(`invalid event for topic ${(event as { topic?: string }).topic}: ${parsed.error.issues[0]?.message}`);
      }
    }
    const stored: StoredEvent = { id: ++this.seq, event };
    let ring = this.rings.get(event.topic);
    if (!ring) {
      ring = [];
      this.rings.set(event.topic, ring);
    }
    ring.push(stored);
    if (ring.length > this.ringSize) ring.splice(0, ring.length - this.ringSize);
    for (const sub of this.subs.values()) {
      if (!sub.patterns.some((p) => topicMatches(p, event.topic))) continue;
      this.enqueue(sub, stored);
    }
    return stored;
  }

  /** Events with id > afterId matching any pattern, in id order (bounded by the ring buffers). */
  replay(afterId: number, patterns: string[]): StoredEvent[] {
    const out: StoredEvent[] = [];
    for (const [topic, ring] of this.rings) {
      if (!patterns.some((p) => topicMatches(p, topic))) continue;
      for (const ev of ring) if (ev.id > afterId) out.push(ev);
    }
    return out.sort((a, b) => a.id - b.id);
  }

  subscribe(patterns: string[], deliver: (events: StoredEvent[]) => void, opts: { coalesceMs?: number } = {}): () => void {
    const id = this.nextSub++;
    const sub: Subscriber = { id, patterns: patterns.length ? patterns : ["*"], deliver, coalesceMs: opts.coalesceMs ?? this.coalesceMs, pending: [], timer: null };
    this.subs.set(id, sub);
    return () => {
      const s = this.subs.get(id);
      if (!s) return;
      if (s.timer) clearTimeout(s.timer);
      this.subs.delete(id);
    };
  }

  subscriberCount(): number {
    return this.subs.size;
  }

  private enqueue(sub: Subscriber, ev: StoredEvent): void {
    if (isCoalescable(ev.event)) {
      // Replace a pending attempt frame of the same run: only the newest matters visually.
      const runId = (ev.event as { frame: { runId: string } }).frame.runId;
      const idx = sub.pending.findIndex((p) => isCoalescable(p.event) && (p.event as { frame: { runId: string } }).frame.runId === runId);
      if (idx >= 0) sub.pending[idx] = ev;
      else sub.pending.push(ev);
      if (!sub.timer) {
        sub.timer = setTimeout(() => {
          sub.timer = null;
          this.flush(sub);
        }, sub.coalesceMs);
      }
      return;
    }
    sub.pending.push(ev);
    // Structural events flush immediately (keeping order with any pending frames).
    if (sub.timer) {
      clearTimeout(sub.timer);
      sub.timer = null;
    }
    this.flush(sub);
  }

  private flush(sub: Subscriber): void {
    if (sub.pending.length === 0) return;
    const batch = sub.pending;
    sub.pending = [];
    try {
      sub.deliver(batch);
    } catch (e) {
      logger.warn("bus: subscriber threw", { id: sub.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

export function isCoalescable(e: CoreEvent): boolean {
  return e.topic === "route.frame" && e.frame.event.kind === "attempt";
}

export function now(): number {
  return Date.now();
}
