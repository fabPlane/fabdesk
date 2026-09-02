/** Server-sent events over the bus with Last-Event-ID catch-up. */
import type { EventBus, StoredEvent } from "../bus";

export function parseTopics(raw: string | null | undefined): string[] {
  if (!raw) return ["*"];
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : ["*"];
}

export function formatSse(ev: StoredEvent): string {
  // No `event:` name: browser EventSource only delivers unnamed events to `onmessage`; the topic lives in the JSON.
  return `id: ${ev.id}\ndata: ${JSON.stringify(ev.event)}\n\n`;
}

export function sseResponse(bus: EventBus, opts: { topics: string[]; lastEventId: number | null; heartbeatMs?: number; signal?: AbortSignal }): Response {
  const enc = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          cleanup();
        }
      };
      write(`retry: 1000\n: connected ${Date.now()}\n\n`);
      if (opts.lastEventId !== null) {
        for (const ev of bus.replay(opts.lastEventId, opts.topics)) write(formatSse(ev));
      }
      unsubscribe = bus.subscribe(opts.topics, (events) => {
        write(events.map(formatSse).join(""));
      });
      heartbeat = setInterval(() => write(`: ping ${Date.now()}\n\n`), opts.heartbeatMs ?? 15_000);
      const cleanup = () => {
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      opts.signal?.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
