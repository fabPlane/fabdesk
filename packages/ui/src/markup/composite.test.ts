import { expect, test } from "bun:test";
import { compositeSize, rasterizeStrokes, sampleMark } from "./composite";
import { MARK_COLOR } from "./strokes";
import { encodePng, pngSize } from "./png";
import type { ArrowStroke, PenStroke } from "./strokes";

test("compositeSize respects device pixel ratio and caps the long edge", () => {
  expect(compositeSize(100, 50, 1)).toEqual({ width: 100, height: 50, scale: 1 });
  expect(compositeSize(100, 50, 2)).toEqual({ width: 200, height: 100, scale: 2 });
  const capped = compositeSize(2000, 1000, 2, 1600);
  expect(capped.width).toBe(1600);
  expect(capped.height).toBe(800);
  expect(capped.scale).toBeCloseTo(0.8);
});

test("rasterizing a pen stroke paints mark colour on a dark background", () => {
  const stroke: PenStroke = { id: "line", tool: "pen", points: [{ x: 8, y: 20 }, { x: 40, y: 20 }] };
  const pixels = rasterizeStrokes(48, 40, [stroke], 1);
  const [r, g, b, a] = sampleMark(pixels, 48, 24, 20);
  expect(a).toBe(255);
  expect(r).toBeGreaterThan(200);
  expect(g).toBeLessThan(80);
  expect(b).toBeLessThan(80);
  const [bgR] = sampleMark(pixels, 48, 24, 4);
  expect(bgR).toBeLessThan(40);
});

test("compositing encodes a PNG of the right size that still contains the marks", () => {
  const arrow: ArrowStroke = { id: "arrow", tool: "arrow", from: { x: 6, y: 6 }, to: { x: 36, y: 28 } };
  const size = compositeSize(40, 32, 1);
  const pixels = rasterizeStrokes(size.width, size.height, [arrow], size.scale);
  const png = encodePng(size.width, size.height, pixels);
  expect(pngSize(png)).toEqual({ width: 40, height: 32 });
  expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const [r] = sampleMark(pixels, size.width, 36, 28);
  expect(r).toBeGreaterThan(200);
  expect(MARK_COLOR).toBe("#ff3d2e");
});
