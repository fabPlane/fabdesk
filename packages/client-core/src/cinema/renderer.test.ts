/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { CinemaShape, RouteFrame, RouteMeta, RouteStatic } from "@fabdesk/protocol";
import {
  CinemaPainter,
  applyLine,
  applyLines,
  computeBounds,
  computeTransform,
  drawScene,
  emptyRun,
  frameStatusText,
  isSuperset,
  layerColor,
  newShapeIds,
  nextFrameSeq,
  perfStatusText,
  toCanvas,
  type Canvas2D,
  type OffscreenLike,
  activityBounds,
  recentShapeAges,
} from "./renderer";

const meta: RouteMeta = {
  kind: "meta",
  runId: "r1",
  router: "fab_router",
  bounds: { x1: 0, y1: 0, x2: 100, y2: 50 },
  layers: ["F.Cu", "B.Cu"],
  unitsPerMm: 1,
};

const shape = (id: number, layer = 0, k: CinemaShape["k"] = "trace"): CinemaShape => ({
  k,
  id,
  layer,
  net: 1,
  pts: k === "trace" ? [0, 0, 10, 10] : [0, 0, 2, 2],
  ...(k === "trace" ? { w: 0.5 } : {}),
});

const frame = (seq: number, ids: number[]): RouteFrame => ({
  kind: "frame",
  runId: "r1",
  seq,
  event: { kind: "attempt", passNo: 1, netNumber: 3, status: "ok" },
  elapsedMs: seq * 100,
  shapes: ids.map((id) => shape(id)),
});

describe("applyLine", () => {
  test("accumulates meta, statics and frames in order", () => {
    const statics: RouteStatic = { kind: "static", runId: "r1", shapes: [shape(100, 0, "pad")] };
    const run = applyLines(emptyRun("r1"), [meta, statics, frame(0, [1]), frame(1, [1, 2])]);
    expect(run.meta?.layers).toEqual(["F.Cu", "B.Cu"]);
    expect(run.statics).toHaveLength(1);
    expect(run.frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(nextFrameSeq(run)).toBe(2);
  });

  test("drops duplicate frames and sorts out-of-order ones", () => {
    const run = applyLines(emptyRun("r1"), [frame(0, [1]), frame(2, [1, 2]), frame(1, [1]), frame(2, [1, 2])]);
    expect(run.frames.map((f) => f.seq)).toEqual([0, 1, 2]);
  });

  test("ignores lines for other runs", () => {
    const run = applyLine(emptyRun("r1"), { ...meta, runId: "other" });
    expect(run.meta).toBeNull();
  });
});

describe("bounds and transform", () => {
  test("uses meta bounds when present, otherwise derives from shapes", () => {
    expect(computeBounds(applyLine(emptyRun("r1"), meta))).toEqual(meta.bounds);
    const run = applyLines(emptyRun("r1"), [{ kind: "static", runId: "r1", shapes: [shape(1, 0, "pad")] }, frame(0, [2])]);
    expect(computeBounds(run)).toEqual({ x1: 0, y1: 0, x2: 10, y2: 10 });
    expect(computeBounds(emptyRun("r1"))).toBeNull();
  });

  test("fits and centres the board with y flipped", () => {
    const t = computeTransform(meta.bounds, 200, 200);
    expect(t.scale).toBeCloseTo(0.94 * 2);
    const [cx, cy] = toCanvas(t, 50, 25);
    expect(cx).toBeCloseTo(100);
    expect(cy).toBeCloseTo(100);
    const [, topY] = toCanvas(t, 0, 50);
    const [, bottomY] = toCanvas(t, 0, 0);
    expect(topY).toBeLessThan(bottomY);
  });
});

describe("newShapeIds", () => {
  test("returns ids absent from the previous frame", () => {
    const fresh = newShapeIds(frame(0, [1, 2]).shapes, frame(1, [1, 2, 3, 4]).shapes);
    expect([...fresh].sort()).toEqual([3, 4]);
    expect([...newShapeIds(undefined, frame(0, [7]).shapes)]).toEqual([7]);
  });
});

describe("status and colours", () => {
  test("layer colours wrap and handle negative layers", () => {
    expect(layerColor(0)).toBe("#e5484d");
    expect(layerColor(12)).toBe("#e5484d");
    expect(layerColor(-1)).toBe("#f43f5e");
  });
  test("status text summarises the frame", () => {
    const run = applyLines(emptyRun("r1"), [meta, frame(0, [1]), frame(1, [1, 2])]);
    expect(frameStatusText(run, 1)).toBe("frame 2/2  ·  attempt pass 1 net 3 → ok  ·  0.1s");
    expect(frameStatusText(applyLine(emptyRun("r1"), meta), -1)).toBe("waiting for frames…");
  });
  test("the last frame reports the result's own complete/open counts and stats", () => {
    const run = applyLines(emptyRun("r1"), [meta, frame(0, [1]), frame(1, [1, 2])]);
    const done = {
      ...run,
      result: {
        runId: "r1",
        router: "fab_router" as const,
        traces: [],
        complete: ["A", "B", "C"],
        open: ["D"],
        timedOut: false,
        stats: { vias: 2, segments: 9, wallMs: 100, frames: 2 },
      },
    };
    expect(frameStatusText(done, 1)).toBe(
      "frame 2/2  ·  attempt pass 1 net 3 → ok  ·  0.1s  ·  done: 3/4 routed, 1 open, 2 vias, 9 segments",
    );
    expect(frameStatusText(done, 0)).not.toContain("done:");
  });
});

describe("drawScene", () => {
  function fakeCtx() {
    const calls: string[] = [];
    const ctx: Canvas2D = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      fillRect: () => calls.push("fillRect"),
      strokeRect: () => calls.push("strokeRect"),
      beginPath: () => calls.push("beginPath"),
      moveTo: () => calls.push("moveTo"),
      lineTo: () => calls.push("lineTo"),
      arc: () => calls.push("arc"),
      stroke: () => calls.push(`stroke:${String(ctx.strokeStyle)}`),
      fill: () => calls.push("fill"),
    };
    return { ctx, calls };
  }

  test("draws new copper white and respects hidden layers", () => {
    const run = applyLines(emptyRun("r1"), [meta, frame(0, [1]), { ...frame(1, [1]), shapes: [shape(1), shape(2, 1)] }]);
    const a = fakeCtx();
    drawScene(a.ctx, { run, cursor: 1, hiddenLayers: new Set(), width: 100, height: 100 });
    // Settled copper in layer colours, then the previous frame's copper in amber and this frame's
    // new copper in white (glow pass + core pass).
    expect(a.calls.filter((c) => c.startsWith("stroke:"))).toEqual(["stroke:#e5484d", "stroke:#3b82f6", "stroke:#ffd166", "stroke:#ffffff", "stroke:#ffffff"]);
    const b = fakeCtx();
    drawScene(b.ctx, { run, cursor: 1, hiddenLayers: new Set([1]), width: 100, height: 100 });
    expect(b.calls.filter((c) => c.startsWith("stroke:"))).toEqual(["stroke:#e5484d", "stroke:#ffd166"]);
  });

  test("returns null without bounds", () => {
    const { ctx } = fakeCtx();
    expect(drawScene(ctx, { run: emptyRun("r1"), cursor: -1, hiddenLayers: new Set(), width: 10, height: 10 })).toBeNull();
  });
});

describe("incremental painter", () => {
  function offscreen() {
    const calls: string[] = [];
    const ctx: OffscreenLike = {
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      fillRect: () => calls.push("fillRect"),
      strokeRect: () => calls.push("strokeRect"),
      beginPath: () => calls.push("beginPath"),
      moveTo: () => calls.push("moveTo"),
      lineTo: () => calls.push("lineTo"),
      arc: () => calls.push("arc"),
      stroke: () => calls.push(`stroke:${String(ctx.strokeStyle)}`),
      fill: () => calls.push("fill"),
      clearRect: () => calls.push("clearRect"),
      drawImage: (img) => calls.push(`drawImage:${String(img)}`),
    };
    return { ctx, calls };
  }

  test("paints statics once, extends copper by the delta while following live, rebuilds on seek", () => {
    const run = applyLines(emptyRun("r1"), [
      meta,
      { kind: "static", runId: "r1", shapes: [shape(100, 0, "pad"), shape(101, 1, "pad")] },
      frame(0, [1]),
      frame(1, [1, 2]),
      frame(2, [1, 2, 3]),
    ]);
    const statics = offscreen();
    const copper = offscreen();
    const screen = offscreen();
    const painter = new CinemaPainter({ statics: statics.ctx, copper: copper.ctx, image: (w) => w });
    const opts = { run, hiddenLayers: new Set<number>(), width: 100, height: 100 };
    const first = painter.paint(screen.ctx, { ...opts, cursor: 0 });
    expect(first.staticsRedrawn).toBe(true);
    expect(first.copperRedrawn).toBe(true);
    // Background + two pads on the statics layer; one trace on the copper layer.
    expect(statics.calls.filter((c) => c === "fillRect").length).toBe(3);
    expect(copper.calls.filter((c) => c.startsWith("stroke:")).length).toBe(1);
    const second = painter.paint(screen.ctx, { ...opts, cursor: 1 });
    expect(second.staticsRedrawn).toBe(false);
    expect(second.copperRedrawn).toBe(false);
    expect(second.copperExtended).toBe(1);
    // Only the first paint cleared the copper layer; the extension did not.
    expect(copper.calls.filter((c) => c === "clearRect").length).toBe(1);
    expect(copper.calls.filter((c) => c.startsWith("stroke:")).length).toBe(2);
    // Fresh copper is highlighted on the visible canvas, over both cached layers.
    expect(screen.calls.filter((c) => c.startsWith("drawImage:")).slice(-2)).toEqual(["drawImage:statics", "drawImage:copper"]);
    // Two paints, one new shape each, glow + core pass per fresh shape.
    expect(screen.calls.filter((c) => c === "stroke:#ffffff").length).toBe(4);
    const seek = painter.paint(screen.ctx, { ...opts, cursor: 0 });
    expect(seek.copperRedrawn).toBe(true);
    expect(copper.calls.filter((c) => c === "clearRect").length).toBe(2);
    const skip = painter.paint(screen.ctx, { ...opts, cursor: 2 });
    expect(skip.copperRedrawn).toBe(true);
    expect(skip.shapes).toBe(2 + 3);
    const hidden = painter.paint(screen.ctx, { ...opts, cursor: 2, hiddenLayers: new Set([1]) });
    expect(hidden.staticsRedrawn).toBe(true);
    // Redrawn with layer 1 hidden: background + one pad.
    expect(statics.calls.filter((c) => c === "fillRect").length).toBe(5);
  });

  test("isSuperset and perf status text", () => {
    expect(isSuperset(frame(0, [1, 2]).shapes, frame(1, [1, 2, 3]).shapes)).toBe(true);
    expect(isSuperset(frame(0, [1, 2]).shapes, frame(1, [1, 3]).shapes)).toBe(false);
    expect(isSuperset(undefined, frame(1, [1]).shapes)).toBe(false);
    expect(perfStatusText({ fps: 12.34, drawMs: 4.06, dropped: 7 }, 1500)).toBe("12 f/s · draw 4.1 ms · 1500 shapes · 7 dropped");
    expect(perfStatusText({ fps: 0, drawMs: 0, dropped: 0 })).toBe("");
    expect(perfStatusText({ fps: 2.5, drawMs: 0, dropped: 0 })).toBe("2.5 f/s");
  });

  test("status text reports kept frames when the store evicted some", () => {
    const run = { ...applyLines(emptyRun("r1"), [meta, frame(5, [1]), frame(6, [1, 2])]), evicted: 4 };
    expect(frameStatusText(run, 1)).toStartWith("frame 6/6 (2 kept)");
  });
});

describe("activity view", () => {
  const meta = { kind: "meta" as const, runId: "r", router: "fab_router", bounds: { x1: 0, y1: 0, x2: 100, y2: 60 }, layers: ["top", "bottom"], unitsPerMm: 1 };
  const frame = (seq: number, ids: number[], airline?: { from: { x: number; y: number }; to: { x: number; y: number } }) => ({
    kind: "frame" as const,
    runId: "r",
    seq,
    event: { kind: "attempt" as const, ...(airline ? { airline } : {}) },
    elapsedMs: seq * 10,
    shapes: ids.map((id) => ({ k: "trace" as const, id, layer: 0, net: 1, pts: [id, id, id + 1, id + 1], w: 0.2 })),
  });
  test("recentShapeAges ages shapes by the frame they first appeared in", () => {
    const run = { runId: "r", meta, statics: [], frames: [frame(1, [1]), frame(2, [1, 2]), frame(3, [1, 2, 3])] };
    const ages = recentShapeAges(run, 2);
    expect(ages.get(3)).toBe(0);
    expect(ages.get(2)).toBe(1);
    expect(ages.get(1)).toBe(2);
    expect(recentShapeAges(run, 2, 1).has(1)).toBe(false);
  });
  test("activityBounds zooms to recent copper plus airline, clamped inside the board", () => {
    const run = { runId: "r", meta, statics: [], frames: [frame(1, [40]), frame(2, [40, 42], { from: { x: 44, y: 44 }, to: { x: 46, y: 45 } })] };
    const b = activityBounds(run, 1, meta.bounds);
    expect(b.x2 - b.x1).toBeGreaterThanOrEqual(14);
    expect(b.x1).toBeGreaterThanOrEqual(0);
    expect(b.y2).toBeLessThanOrEqual(60);
    expect(b.x1).toBeLessThanOrEqual(40);
    expect(b.x2).toBeGreaterThanOrEqual(46);
  });
  test("activityBounds falls back to the board without frames", () => {
    expect(activityBounds({ runId: "r", meta, statics: [], frames: [] }, -1, meta.bounds)).toEqual(meta.bounds);
  });
});
