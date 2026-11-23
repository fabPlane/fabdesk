/// <reference types="bun-types" />
import { beforeEach, describe, expect, test } from "bun:test";
import type { RouteFrame } from "@fabdesk/protocol";
import { emptyRun } from "../board/cinema/renderer";
import { capFrames, droppedFrames, updateFps, useCinemaStore } from "./cinema";

beforeEach(() => useCinemaStore.setState({ runs: {}, activeRunId: null, cursor: -1, playing: false, followLive: true, perf: { fps: 0, drawMs: 0, received: 0, dropped: 0 } }));

const frame = (seq: number, kind: RouteFrame["event"]["kind"] = "attempt"): RouteFrame => ({
  kind: "frame",
  runId: "r1",
  seq,
  event: { kind },
  elapsedMs: seq,
  shapes: [],
});

describe("frame retention", () => {
  test("capFrames evicts the oldest non-structural frames and keeps count", () => {
    const run = {
      ...emptyRun("r1"),
      frames: [frame(1, "pass-start"), frame(2), frame(3), frame(4), frame(5, "done")],
    };
    const capped = capFrames(run, 3);
    expect(capped.frames.map((f) => f.seq)).toEqual([1, 4, 5]);
    expect(capped.evicted).toBe(2);
    expect(capFrames(capped, 3)).toBe(capped);
    expect(capFrames({ ...capped, frames: [...capped.frames, frame(6)] }, 3).evicted).toBe(3);
  });
  test("droppedFrames counts seq gaps net of evictions", () => {
    expect(droppedFrames({ ...emptyRun("r1"), frames: [frame(1), frame(2), frame(5)] })).toBe(2);
    expect(droppedFrames({ ...emptyRun("r1"), frames: [frame(4), frame(5)], evicted: 3 })).toBe(0);
    expect(droppedFrames(emptyRun("r1"))).toBe(0);
  });
  test("updateFps smooths inter-arrival times", () => {
    expect(updateFps(0, null, 100)).toBe(0);
    expect(updateFps(0, 0, 100)).toBeCloseTo(10);
    expect(updateFps(10, 0, 50)).toBeCloseTo(12);
  });
  test("the store caps frames, tracks perf and follows live", () => {
    const s = useCinemaStore.getState();
    s.setActiveRun("r1");
    s.ingest({
      kind: "meta",
      runId: "r1",
      router: "fab_router",
      bounds: { x1: 0, y1: 0, x2: 1, y2: 1 },
      layers: ["top"],
      unitsPerMm: 1,
    });
    for (let i = 1; i <= 450; i += 1) s.ingest(frame(i * 2));
    const st = useCinemaStore.getState();
    const run = st.runs["r1"]!;
    expect(run.frames.length).toBe(400);
    expect(run.evicted).toBe(50);
    expect(st.perf.received).toBe(450);
    expect(st.perf.dropped).toBe(450);
    expect(st.cursor).toBe(399);
    s.reportDraw(3.14);
    expect(useCinemaStore.getState().perf.drawMs).toBe(3.1);
  });
});


describe("project-owned run selection", () => {
  const meta = (runId: string) => ({ kind: "meta" as const, runId, router: "fab_router", bounds: { x1: 0, y1: 0, x2: 1, y2: 1 }, layers: ["top"], unitsPerMm: 1 });
  test("background metadata and history are cached without choosing an unverified run", () => {
    const store = useCinemaStore.getState();
    store.ingest(meta("foreign"));
    store.ingestMany("history", [{ ...frame(1), runId: "history" }]);
    expect(useCinemaStore.getState().activeRunId).toBeNull();
    expect(useCinemaStore.getState().runs.foreign?.meta?.runId).toBe("foreign");
    expect(useCinemaStore.getState().runs.history?.frames).toHaveLength(1);
  });
  test("another run cannot interrupt playback or replace its performance counters", () => {
    const store = useCinemaStore.getState();
    store.setActiveRun("r1"); store.ingest(meta("r1"));
    store.ingest(frame(1)); store.ingest(frame(2)); store.seek(0); store.reportDraw(3.1);
    const perf = useCinemaStore.getState().perf;
    store.ingest(meta("foreign")); store.ingest({ ...frame(1), runId: "foreign" });
    const state = useCinemaStore.getState();
    expect(state.activeRunId).toBe("r1"); expect(state.cursor).toBe(0); expect(state.followLive).toBe(false);
    expect(state.perf).toEqual(perf); expect(state.runs.foreign?.frames).toHaveLength(1);
  });
});
