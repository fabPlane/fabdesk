import { describe, expect, test } from "bun:test";
import { fillCircle, fillRect, makeGray } from "../src/image";
import { convertImage } from "../src/styles";
import { MIN_FEATURE_MM } from "../src/types";

function face() {
  const img = makeGray(64, 64, 255);
  fillCircle(img, 32, 32, 22, 30);
  fillCircle(img, 24, 26, 4, 220);
  fillCircle(img, 40, 26, 4, 220);
  fillRect(img, 24, 40, 16, 3, 220);
  return img;
}

const base = {
  widthMm: 40,
  heightMm: 40,
  color: "green" as const,
  outline: "rectangle" as const,
  minFeatureMm: 0.2,
  pitchMm: 0.8,
  marginMm: 2,
};

describe("conversion styles", () => {
  test("realistic emits dots at or above the fab floor", () => {
    const art = convertImage(face(), { ...base, style: "realistic" });
    expect(art.primitives.length).toBeGreaterThan(20);
    expect(art.primitives.every((p) => p.kind === "circle")).toBe(true);
    expect(art.primitives.every((p) => p.kind === "circle" && p.d + 1e-9 >= MIN_FEATURE_MM)).toBe(true);
    const xs = art.primitives.filter((p) => p.kind === "circle").map((p) => p.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(base.marginMm - 1e-6);
    expect(Math.max(...xs)).toBeLessThanOrEqual(base.widthMm - base.marginMm + 1e-6);
  });

  test("retro emits horizontal lines thicker than the fab floor", () => {
    const art = convertImage(face(), { ...base, style: "retro" });
    expect(art.primitives.length).toBeGreaterThan(5);
    expect(art.primitives.every((p) => p.kind === "line")).toBe(true);
    for (const p of art.primitives) {
      if (p.kind !== "line") continue;
      expect(p.w).toBeGreaterThanOrEqual(MIN_FEATURE_MM);
      expect(p.y1).toBe(p.y2);
      expect(p.x2 - p.x1).toBeGreaterThanOrEqual(MIN_FEATURE_MM);
    }
  });

  test("poster emits one-cut rectangles and skips light areas", () => {
    const img = makeGray(32, 32, 255);
    fillRect(img, 8, 8, 16, 16, 0);
    const art = convertImage(img, { ...base, style: "poster", threshold: 0.5, pitchMm: 1 });
    expect(art.primitives.length).toBeGreaterThan(0);
    expect(art.primitives.every((p) => p.kind === "rect")).toBe(true);
    const area = art.primitives.reduce((n, p) => n + (p.kind === "rect" ? p.w * p.h : 0), 0);
    expect(area).toBeGreaterThan(80);
    expect(area).toBeLessThan(40 * 40);
  });

  test("invert flips which regions become ink", () => {
    const img = makeGray(32, 32, 255);
    fillRect(img, 0, 0, 16, 32, 0);
    const dark = convertImage(img, { ...base, style: "poster", pitchMm: 2, invert: false });
    const light = convertImage(img, { ...base, style: "poster", pitchMm: 2, invert: true });
    const mid = (p: (typeof dark.primitives)[number]) => (p.kind === "rect" ? p.x + p.w / 2 : 0);
    const darkLeft = dark.primitives.filter((p) => mid(p) < 20).length;
    const lightLeft = light.primitives.filter((p) => mid(p) < 20).length;
    expect(darkLeft).toBeGreaterThan(lightLeft);
  });

  test("circle outline drops primitives outside the disk", () => {
    const img = makeGray(32, 32, 0);
    const art = convertImage(img, { ...base, style: "poster", outline: "circle", pitchMm: 2 });
    expect(art.clipped.length).toBeLessThan(art.primitives.length);
    expect(art.clipped.length).toBeGreaterThan(0);
  });
});
