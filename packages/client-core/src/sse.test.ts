/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { appendLastEventId, reconnectDelay, subscribeSse, type EventSourceLike } from "./sse";

class FakeSource implements EventSourceLike {
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  closedCalls = 0;
  constructor(public url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  emit(data: unknown, id: string) {
    this.onmessage?.({ data: JSON.stringify(data), lastEventId: id });
  }
  fail() {
    this.readyState = 2;
    this.onerror?.({});
  }
  close() {
    this.closedCalls += 1;
    this.readyState = 2;
  }
}

function harness() {
  const sources: FakeSource[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const events: string[] = [];
  const statuses: string[] = [];
  const sub = subscribeSse({
    buildUrl: () => "http://127.0.0.1:1/events?token=t&topics=*",
    factory: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    onEvent: (e) => events.push(e.topic),
    onStatus: (s) => statuses.push(s),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: () => {},
  });
  return { sub, sources, timers, events, statuses };
}

describe("subscribeSse", () => {
  test("dispatches parsed events and tracks the last event id", () => {
    const h = harness();
    const s = h.sources[0]!;
    s.open();
    s.emit({ topic: "thread.updated", threadId: "a", ts: 1 }, "7");
    s.emit("not-json-object", "8");
    expect(h.events).toEqual(["thread.updated"]);
    expect(h.sub.lastEventId).toBe("8");
    expect(h.sub.status).toBe("open");
  });

  test("reconnects after a fatal close with backoff and forwards Last-Event-ID", () => {
    const h = harness();
    const s1 = h.sources[0]!;
    s1.open();
    s1.emit({ topic: "thread.updated", threadId: "a", ts: 1 }, "41");
    s1.fail();
    expect(h.sub.status).toBe("reconnecting");
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]!.ms).toBe(1000);
    h.timers[0]!.fn();
    expect(h.sources).toHaveLength(2);
    expect(h.sources[1]!.url).toContain("lastEventId=41");
    h.sources[1]!.fail();
    expect(h.timers[1]!.ms).toBe(2000);
    h.timers[1]!.fn();
    h.sources[2]!.open();
    expect(h.sub.attempt).toBe(0);
    expect(h.sub.status).toBe("open");
  });

  test("transient errors do not spawn a new source", () => {
    const h = harness();
    const s1 = h.sources[0]!;
    s1.open();
    s1.readyState = 0;
    s1.onerror?.({});
    expect(h.sources).toHaveLength(1);
    expect(h.timers).toHaveLength(0);
    expect(h.sub.status).toBe("reconnecting");
  });

  test("close stops reconnection", () => {
    const h = harness();
    h.sources[0]!.fail();
    h.sub.close();
    h.timers[0]!.fn();
    expect(h.sources).toHaveLength(1);
    expect(h.sub.status).toBe("closed");
  });
});

describe("helpers", () => {
  test("reconnectDelay grows exponentially and caps", () => {
    expect(reconnectDelay(1)).toBe(1000);
    expect(reconnectDelay(3)).toBe(4000);
    expect(reconnectDelay(10)).toBe(15000);
  });
  test("appendLastEventId respects existing query", () => {
    expect(appendLastEventId("http://x/events", null)).toBe("http://x/events");
    expect(appendLastEventId("http://x/events?a=1", "5")).toBe("http://x/events?a=1&lastEventId=5");
    expect(appendLastEventId("http://x/events", "a b")).toBe("http://x/events?lastEventId=a%20b");
  });
});
