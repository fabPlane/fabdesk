import { test, expect } from "bun:test";
import { makeGray } from "../src/image";
import { buildBoardArt } from "../src/job";
import { fitArtPlacement, imagePointAt, pointInArtworkCrop } from "../src/placement";

const portrait = makeGray(20, 40, 0);
const base = { widthMm: 80, heightMm: 50, color: "green" as const, outline: "rectangle" as const };
test("circle crop fits a centred square and fills it without portrait letterboxing", () => {
  const p = fitArtPlacement(portrait, 80, 50, 0, 2, "circle");
  expect(p).toEqual({ centerXmm: 40, centerYmm: 25, widthMm: 46, heightMm: 46, rotationDeg: 0 });
  const left = imagePointAt(p, portrait, 17, 25, "circle");
  expect(left.x).toBeCloseTo(0);
  expect(left.y).toBeCloseTo(20);
});
for (const style of ["realistic", "retro", "poster"] as const)
  test(`${style}: crop travels with artwork on a rectangular board`, () => {
    const placement = { centerXmm: 24, centerYmm: 27, widthMm: 18, heightMm: 18, rotationDeg: 37 };
    const job = buildBoardArt(portrait, { ...base, style, crop: "circle", placement });
    expect(job.options.outline).toBe("rectangle");
    expect(job.art.clipped.length).toBeGreaterThan(0);
    for (const p of job.art.clipped) {
      const x = p.kind === "circle" ? p.x : p.kind === "rect" ? p.x + p.w / 2 : (p.x1 + p.x2) / 2;
      const y = p.kind === "circle" ? p.y : p.kind === "rect" ? p.y + p.h / 2 : (p.y1 + p.y2) / 2;
      expect(Math.hypot(x - 24, y - 27)).toBeLessThanOrEqual(9.00001);
    }
    expect(job.kicadPcb).toContain("F.SilkS");
  });
test("rounded crop rotates independently of board shape", () => {
  const p = { centerXmm: 30, centerYmm: 20, widthMm: 20, heightMm: 10, rotationDeg: 90 };
  expect(pointInArtworkCrop(p, "rounded", 30, 28)).toBe(true);
  expect(pointInArtworkCrop(p, "rounded", 38, 20)).toBe(false);
  expect(pointInArtworkCrop(p, "none", 38, 20)).toBe(true);
});
