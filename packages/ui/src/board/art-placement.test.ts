import { test, expect } from "bun:test";
import { resizeArtwork } from "./art-placement";
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
