/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import type { CinemaShape, RouteFrame, RouteMeta, RouteStatic } from "@fabdesk/protocol";
import {
  applyLine,
  applyLines,
  computeBounds,
  computeTransform,
  drawScene,
  emptyRun,
  frameStatusText,
  layerColor,
  newShapeIds,
  nextFrameSeq,
  toCanvas,
  type Canvas2D,
} from "./renderer";

const meta: RouteMeta = {
  kind: "meta",
  runId: "r1",
  router: "capacity",
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
    expect(a.calls.filter((c) => c.startsWith("stroke:"))).toEqual(["stroke:#e5484d", "stroke:#ffffff"]);
    const b = fakeCtx();
    drawScene(b.ctx, { run, cursor: 1, hiddenLayers: new Set([1]), width: 100, height: 100 });
    expect(b.calls.filter((c) => c.startsWith("stroke:"))).toEqual(["stroke:#e5484d"]);
  });

  test("returns null without bounds", () => {
    const { ctx } = fakeCtx();
    expect(drawScene(ctx, { run: emptyRun("r1"), cursor: -1, hiddenLayers: new Set(), width: 10, height: 10 })).toBeNull();
  });
});
