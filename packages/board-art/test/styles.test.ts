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

  test("circle outline trims runs to the disk and keeps interior coverage", () => {
    const img = makeGray(32, 32, 0);
    const o = { ...base, style: "poster" as const, outline: "circle" as const, pitchMm: 1 };
    const art = convertImage(img, o);
    const r = 20;
    const inDisk = (x: number, y: number) => (x - 20) ** 2 + (y - 20) ** 2 <= r * r + 1e-6;
    let expected = 0;
    const step = 0.1;
    for (let y = 2 + step / 2; y < 38; y += step)
      for (let x = 2 + step / 2; x < 38; x += step) if (inDisk(x, y)) expected += step * step;
    let kept = 0;
    for (const p of art.clipped) {
      if (p.kind !== "rect") throw new Error("poster emits rects");
      for (const [x, y] of [
        [p.x, p.y],
        [p.x + p.w, p.y],
        [p.x, p.y + p.h],
        [p.x + p.w, p.y + p.h],
      ] as const)
        expect(inDisk(x, y)).toBe(true);
      kept += p.w * p.h;
    }
    expect(art.clipped.length).toBe(art.primitives.length);
    expect(kept / expected).toBeGreaterThan(0.93);
    expect(kept).toBeLessThanOrEqual(expected + 1e-6);
  });

  test("retro lines on a rounded board are trimmed, caps included, not dropped", () => {
    const img = makeGray(32, 32, 0);
    const o = { ...base, style: "retro" as const, outline: "rounded" as const, marginMm: 0, pitchMm: 1 };
    const art = convertImage(img, o);
    const lines = art.clipped.filter((p) => p.kind === "line");
    expect(lines.length).toBe(art.primitives.length);
    const rr = 40 * 0.08;
    const inside = (x: number, y: number) => {
      const cx = Math.min(Math.max(x, rr), 40 - rr);
      const cy = Math.min(Math.max(y, rr), 40 - rr);
      return (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr + 1e-6;
    };
    for (const p of lines) {
      if (p.kind !== "line") continue;
      for (const dy of [-p.w / 2, p.w / 2]) {
        expect(inside(p.x1 - p.w / 2, p.y1 + dy)).toBe(true);
        expect(inside(p.x2 + p.w / 2, p.y1 + dy)).toBe(true);
      }
    }
    const first = lines[0];
    expect(first && first.kind === "line" ? first.x2 - first.x1 : 0).toBeGreaterThan(30);
  });
});
