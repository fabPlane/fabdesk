import { describe, expect, test } from "bun:test";
import { parseWsFrame, subscribeWs, type WebSocketLike } from "./ws";

class FakeSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const events: Array<{ topic: string; id: string }> = [];
  const statuses: string[] = [];
  const sub = subscribeWs({
    buildUrl: () => `ws://host/ws?n=${sockets.length}`,
    topics: ["agent.*"],
    factory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    onEvent: (event, id) => events.push({ topic: event.topic, id }),
    onStatus: (s) => statuses.push(s),
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimeout: () => {},
  });
  return { sockets, timers, events, statuses, sub };
}

describe("parseWsFrame", () => {
  test("reads an {id, event} envelope", () => {
    const frame = parseWsFrame(
      JSON.stringify({ id: 7, event: { topic: "thread.updated", ts: 1, threadId: "th_1" } }),
    );
    expect(frame?.id).toBe(7);
    expect(frame?.event.topic).toBe("thread.updated");
  });

  test("rejects junk, non-strings and envelopes without an id", () => {
    expect(parseWsFrame("not json")).toBeNull();
    expect(parseWsFrame(new Uint8Array([1, 2]))).toBeNull();
    expect(parseWsFrame(JSON.stringify({ event: { topic: "x", ts: 1 } }))).toBeNull();
    expect(parseWsFrame(JSON.stringify({ id: 1, event: { ts: 1 } }))).toBeNull();
  });
});

describe("subscribeWs", () => {
  test("subscribes on open and reports events with their ids", async () => {
    const h = harness();
    h.sockets[0]!.onopen?.({});
    await Promise.resolve();
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ subscribe: ["agent.*"] });
    expect(h.statuses).toContain("open");

    h.sockets[0]!.onmessage?.({
      data: JSON.stringify({ id: 12, event: { topic: "thread.updated", ts: 1, threadId: "th_1" } }),
    });
    expect(h.events).toEqual([{ topic: "thread.updated", id: "12" }]);
    expect(h.sub.lastEventId).toBe("12");
  });

  test("resumes from the last id after a reconnect, with backoff", async () => {
    const h = harness();
    h.sockets[0]!.onopen?.({});
    await Promise.resolve();
    h.sockets[0]!.onmessage?.({
      data: JSON.stringify({ id: 5, event: { topic: "thread.updated", ts: 1, threadId: "th_1" } }),
    });

    h.sockets[0]!.onclose?.({});
    expect(h.statuses).toContain("reconnecting");
    expect(h.timers[0]!.ms).toBe(1000);

    h.timers[0]!.fn();
    h.sockets[1]!.onopen?.({});
    await Promise.resolve();
    expect(JSON.parse(h.sockets[1]!.sent[0]!)).toEqual({ subscribe: ["agent.*"], lastEventId: 5 });
  });

  test("drops the cursor when the host says the daemon restarted", async () => {
    const sockets: FakeSocket[] = [];
    let resume = true;
    const sub = subscribeWs({
      buildUrl: () => "ws://host/ws",
      topics: ["*"],
      factory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onEvent: () => {},
      canResume: () => resume,
      setTimeout: (fn) => {
        fn();
        return 0;
      },
      clearTimeout: () => {},
    });
    sockets[0]!.onopen?.({});
    await Promise.resolve();
    sockets[0]!.onmessage?.({
      data: JSON.stringify({ id: 9, event: { topic: "thread.updated", ts: 1, threadId: "t" } }),
    });
    expect(sub.lastEventId).toBe("9");

    resume = false;
    sockets[0]!.onclose?.({});
    sockets[1]!.onopen?.({});
    await Promise.resolve();
    expect(JSON.parse(sockets[1]!.sent[0]!)).toEqual({ subscribe: ["*"] });
    sub.close();
  });

  test("close() stops reconnecting", () => {
    const h = harness();
    h.sockets[0]!.onopen?.({});
    h.sub.close();
    expect(h.sockets[0]!.closed).toBe(true);
    const before = h.sockets.length;
    h.sockets[0]!.onclose?.({});
    expect(h.sockets.length).toBe(before);
    expect(h.sub.status).toBe("closed");
  });
});
