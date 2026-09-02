import { describe, expect, test } from "bun:test";
import type { CoreEvent } from "@fabdesk/protocol";
import { EventBus } from "../src/bus";

const frame = (runId: string, seq: number, kind: "attempt" | "connection" | "pass-start"): CoreEvent => ({
  ts: Date.now(),
  topic: "route.frame",
  frame: { kind: "frame", runId, seq, event: { kind }, elapsedMs: seq, shapes: [] },
});

describe("EventBus", () => {
  test("validates events and matches topic patterns", () => {
    const bus = new EventBus();
    expect(() => bus.emit({ ts: 1, topic: "nope" } as never)).toThrow();
    const got: string[] = [];
    bus.subscribe(["agent.*", "thread.updated"], (evs) => evs.forEach((e) => got.push(e.event.topic)), { coalesceMs: 0 });
    bus.emit({ ts: 1, topic: "agent.started", runId: "r", threadId: "t", agentId: "claude" });
    bus.emit({ ts: 1, topic: "job.started", jobId: "j", kind: "k" });
    bus.emit({ ts: 1, topic: "thread.updated", threadId: "t" });
    expect(got).toEqual(["agent.started", "thread.updated"]);
  });

  test("ring buffer per topic caps at ringSize and replay orders by id", () => {
    const bus = new EventBus({ ringSize: 3 });
    for (let i = 0; i < 5; i++) bus.emit({ ts: i, topic: "thread.updated", threadId: `t${i}` });
    bus.emit({ ts: 9, topic: "job.started", jobId: "j", kind: "k" });
    const all = bus.replay(0, ["*"]);
    expect(all.map((e) => e.id)).toEqual([3, 4, 5, 6]);
    expect(bus.replay(4, ["thread.*"]).map((e) => (e.event as { threadId: string }).threadId)).toEqual(["t4"]);
    expect(bus.replay(6, ["*"])).toEqual([]);
    expect(bus.lastId).toBe(6);
  });

  test("coalesces attempt frames per run within the window, never drops structural events", async () => {
    const bus = new EventBus({ coalesceMs: 20 });
    const batches: CoreEvent[][] = [];
    bus.subscribe(["route.*"], (evs) => batches.push(evs.map((e) => e.event)));
    bus.emit(frame("a", 1, "attempt"));
    bus.emit(frame("a", 2, "attempt"));
    bus.emit(frame("b", 1, "attempt"));
    bus.emit(frame("a", 3, "attempt"));
    expect(batches.length).toBe(0);
    await new Promise((r) => setTimeout(r, 40));
    expect(batches.length).toBe(1);
    const seqs = batches[0]!.map((e) => (e as { frame: { runId: string; seq: number } }).frame).map((f) => `${f.runId}${f.seq}`);
    expect(seqs).toEqual(["a3", "b1"]);
    // Structural frame flushes immediately, including any pending attempt.
    bus.emit(frame("a", 4, "attempt"));
    bus.emit(frame("a", 5, "connection"));
    expect(batches.length).toBe(2);
    expect(batches[1]!.length).toBe(2);
    bus.emit({ ts: 1, topic: "route.done", result: { runId: "a", router: "capacity", traces: [], complete: [], open: [], timedOut: false, stats: { vias: 0, segments: 0, wallMs: 1, frames: 5 } } });
    expect(batches.length).toBe(3);
    // Everything is still in the ring for catch-up.
    expect(bus.replay(0, ["route.frame"]).length).toBe(6);
  });

  test("unsubscribe stops delivery", () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.subscribe(["*"], () => n++);
    bus.emit({ ts: 1, topic: "thread.updated", threadId: "t" });
    off();
    bus.emit({ ts: 1, topic: "thread.updated", threadId: "t" });
    expect(n).toBe(1);
    expect(bus.subscriberCount()).toBe(0);
  });
});
