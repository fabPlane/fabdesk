import { describe, expect, test } from "bun:test";
import type { RouteFrame, RouteFrameLine, RouteMeta, RouteResult } from "@fabdesk/protocol";
import {
  MAX_FRAMES,
  capFrames,
  cinemaReducer,
  cursorFraction,
  droppedFrames,
  fractionCursor,
  initialPlayback,
  type CinemaAction,
  type CinemaPlayback,
} from "./cinema-frames";

const meta: RouteMeta = {
  kind: "meta",
  runId: "r1",
  router: "capacity",
  bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
  layers: ["F.Cu", "B.Cu"],
  unitsPerMm: 1,
};

function frame(
  seq: number,
  kind: RouteFrame["event"]["kind"] = "attempt",
  runId = "r1",
): RouteFrame {
  return { kind: "frame", runId, seq, event: { kind }, elapsedMs: seq * 10, shapes: [] };
}

function reduce(state: CinemaPlayback, ...actions: CinemaAction[]): CinemaPlayback {
  return actions.reduce(cinemaReducer, state);
}

const loaded = reduce(initialPlayback("r1"), {
  type: "ingest",
  lines: [meta, frame(0), frame(1), frame(2)],
});

describe("ingest", () => {
  test("keeps frames in order, follows live, and counts what it kept", () => {
    expect(loaded.run.meta).toEqual(meta);
    expect(loaded.run.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
    expect(loaded.cursor).toBe(2);
    expect(loaded.received).toBe(3);
  });

  test("ignores lines for another run, and does not double-count a catch-up that overlaps", () => {
    const other = reduce(loaded, { type: "ingest", lines: [frame(9, "attempt", "r2")] });
    expect(other).toBe(loaded);
    const overlap = reduce(loaded, { type: "ingest", lines: [frame(1), frame(2), frame(3)] });
    expect(overlap.run.frames.map((f) => f.seq)).toEqual([0, 1, 2, 3]);
    expect(overlap.received).toBe(4);
  });

  test("leaves the cursor alone once the user has scrubbed", () => {
    const scrubbed = reduce(
      loaded,
      { type: "seek", index: 0 },
      { type: "ingest", lines: [frame(3)] },
    );
    expect(scrubbed.cursor).toBe(0);
    expect(scrubbed.followLive).toBe(false);
  });
});

describe("playback", () => {
  test("play from the end restarts; tick advances and stops at the last frame", () => {
    let s = reduce(loaded, { type: "togglePlaying" });
    expect(s.playing).toBe(true);
    expect(s.followLive).toBe(false);
    expect(s.cursor).toBe(0);
    s = reduce(s, { type: "tick" }, { type: "tick" });
    expect(s.cursor).toBe(2);
    s = reduce(s, { type: "tick" });
    expect(s.playing).toBe(false);
    expect(s.cursor).toBe(2);
  });

  test("a tick while paused is a no-op; step pauses; goLive jumps to the newest frame", () => {
    expect(reduce(loaded, { type: "tick" })).toBe(loaded);
    const stepped = reduce(loaded, { type: "togglePlaying" }, { type: "step", delta: 1 });
    expect(stepped.playing).toBe(false);
    expect(stepped.cursor).toBe(1);
    const live = reduce(stepped, { type: "goLive" });
    expect(live).toMatchObject({ cursor: 2, followLive: true, playing: false });
  });

  test("seek and step clamp to the run, and play does nothing on an empty run", () => {
    expect(reduce(loaded, { type: "seek", index: 99 }).cursor).toBe(2);
    expect(reduce(loaded, { type: "step", delta: -99 }).cursor).toBe(0);
    const empty = initialPlayback("r1");
    expect(reduce(empty, { type: "togglePlaying" })).toBe(empty);
    expect(reduce(empty, { type: "seek", index: 3 }).cursor).toBe(-1);
  });

  test("done attaches the result to its own run only", () => {
    const result: RouteResult = {
      runId: "r1",
      router: "capacity",
      complete: ["a"],
      open: [],
      timedOut: false,
      stats: { vias: 1, segments: 2, wallMs: 3, frames: 3 },
    };
    expect(reduce(loaded, { type: "done", result }).run.result).toEqual(result);
    expect(reduce(loaded, { type: "done", result: { ...result, runId: "r2" } })).toBe(loaded);
  });

  test("layers toggle on and off", () => {
    const off = reduce(loaded, { type: "toggleLayer", layer: 1 });
    expect(off.hiddenLayers).toEqual([1]);
    expect(reduce(off, { type: "toggleLayer", layer: 1 }).hiddenLayers).toEqual([]);
  });
});

describe("capFrames", () => {
  test("evicts the oldest ordinary frames past the cap but keeps pass-start and done", () => {
    const lines: RouteFrameLine[] = [meta, frame(0, "pass-start")];
    for (let i = 1; i <= MAX_FRAMES + 20; i += 1) lines.push(frame(i));
    lines.push(frame(MAX_FRAMES + 21, "done"));
    const s = reduce(initialPlayback("r1"), { type: "ingest", lines });
    expect(s.run.frames.length).toBe(MAX_FRAMES);
    expect(s.run.frames[0]?.event.kind).toBe("pass-start");
    expect(s.run.frames[s.run.frames.length - 1]?.event.kind).toBe("done");
    expect(s.run.evicted).toBe(22);
    expect(s.received).toBe(MAX_FRAMES + 22);
    expect(s.cursor).toBe(MAX_FRAMES - 1);
  });

  test("is the identity under the cap", () => {
    expect(capFrames(loaded.run)).toBe(loaded.run);
  });
});

test("droppedFrames counts seq gaps the client never received", () => {
  expect(droppedFrames(loaded.run)).toBe(0);
  // Same arithmetic as the desktop store (seq numbering is treated as 1-based there).
  const gappy = reduce(loaded, { type: "ingest", lines: [frame(7)] });
  expect(droppedFrames(gappy.run)).toBe(3);
  expect(droppedFrames(initialPlayback("x").run)).toBe(0);
});

test("scrub bar fractions round-trip and clamp", () => {
  expect(cursorFraction(-1, 0)).toBe(0);
  expect(cursorFraction(2, 3)).toBe(1);
  expect(cursorFraction(1, 3)).toBe(0.5);
  expect(fractionCursor(0.5, 3)).toBe(1);
  expect(fractionCursor(1.7, 3)).toBe(2);
  expect(fractionCursor(-1, 3)).toBe(0);
  expect(fractionCursor(0.3, 0)).toBe(-1);
});
