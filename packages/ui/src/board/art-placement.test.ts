import { test, expect } from "bun:test";
import { placementAfterBoardResize, resizeArtwork } from "./art-placement";
const p = { centerXmm: 30, centerYmm: 30, widthMm: 20, heightMm: 10, rotationDeg: 0 };
test("corner resize holds opposite corner still and preserves aspect ratio", () => {
  const next = resizeArtwork(p, 60, 45, 1, 1, true);
  expect(next.widthMm / next.heightMm).toBeCloseTo(2);
  expect(next.centerXmm - next.widthMm / 2).toBeCloseTo(20);
  expect(next.centerYmm - next.heightMm / 2).toBeCloseTo(25);
});
test("rotated resize uses the local image axes", () => {
  const next = resizeArtwork({ ...p, rotationDeg: 90 }, 20, 50, 1, 1, false);
  expect(next.widthMm).toBeCloseTo(30);
  expect(next.heightMm).toBeCloseTo(15);
  expect(next.centerXmm).toBeCloseTo(27.5);
  expect(next.centerYmm).toBeCloseTo(35);
});

test("shrinking 80×50 to 40×40 keeps the moved and rotated image inside the board", () => {
  const next = placementAfterBoardResize(
    { ...p, centerXmm: 69, centerYmm: 39, rotationDeg: 35 },
    80,
    50,
    40,
    40,
  )!;
  expect(next.rotationDeg).toBe(35);
  expect(next.widthMm / next.heightMm).toBeCloseTo(2);
  const a = (35 * Math.PI) / 180;
  const halfW = (next.widthMm * Math.cos(a) + next.heightMm * Math.sin(a)) / 2;
  const halfH = (next.widthMm * Math.sin(a) + next.heightMm * Math.cos(a)) / 2;
  expect(next.centerXmm - halfW).toBeGreaterThanOrEqual(2);
  expect(next.centerXmm + halfW).toBeLessThanOrEqual(38.000001);
  expect(next.centerYmm - halfH).toBeGreaterThanOrEqual(2);
  expect(next.centerYmm + halfH).toBeLessThanOrEqual(38.000001);
});

test("changing size preserves relative position when it fits and keeps circle crops square", () => {
  const image = { ...p, widthMm: 12, heightMm: 12, centerXmm: 50, centerYmm: 25, rotationDeg: 20 };
  const large = placementAfterBoardResize(image, 80, 50, 100, 100, "rectangle", "circle")!;
  expect(large.centerXmm).toBeCloseTo(62.5);
  expect(large.centerYmm).toBeCloseTo(50);
  const small = placementAfterBoardResize(large, 100, 100, 40, 40, "rectangle", "circle")!;
  expect(small.widthMm).toBeCloseTo(small.heightMm);
  expect(small.centerXmm).toBeCloseTo(25);
  expect(small.centerYmm).toBeCloseTo(20);
});

test("circular boards keep the resized image inside the physical circle", () => {
  const next = placementAfterBoardResize(
    { ...p, centerXmm: 90, centerYmm: 90 },
    100,
    100,
    40,
    40,
    "circle",
  )!;
  expect(
    Math.hypot(next.centerXmm - 20, next.centerYmm - 20) +
      Math.hypot(next.widthMm, next.heightMm) / 2,
  ).toBeLessThanOrEqual(18.000001);
});

test("automatic fit stays automatic across board-size changes", () => {
  expect(placementAfterBoardResize(null, 80, 50, 40, 40)).toBeNull();
});
