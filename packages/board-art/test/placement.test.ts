import { expect, test } from "bun:test";
import { fitArtPlacement, imagePointAt } from "../src/placement";
import { buildBoardArt } from "../src/job";
import { makeGray } from "../src/image";
import { parseGerber } from "../src/gerber";
import { resolveArtOptions } from "../src/types";

const image = makeGray(20, 10, 0);
const base = {
  widthMm: 80,
  heightMm: 60,
  style: "realistic" as const,
  color: "green" as const,
  outline: "rectangle" as const,
  pitchMm: 0.5,
};

test("fit preserves proportions and fits the rotated bounding box", () => {
  const p = fitArtPlacement(image, 80, 60, 90);
  expect(p.centerXmm).toBe(40);
  expect(p.centerYmm).toBe(30);
  expect(p.widthMm / p.heightMm).toBe(2);
  expect(p.widthMm).toBeCloseTo(56);
  expect(p.heightMm).toBeCloseTo(28);
});

test("inverse placement maps translation, scale, and clockwise rotation", () => {
  const p = { centerXmm: 30, centerYmm: 25, widthMm: 20, heightMm: 10, rotationDeg: 90 };
  const at = imagePointAt(p, image, 30, 30);
  expect(at.x).toBeCloseTo(15);
  expect(at.y).toBeCloseTo(5);
});

for (const style of ["realistic", "retro", "poster"] as const)
  test(`${style}: rotated artwork reaches preview and Gerber at the selected position`, () => {
    const placement = { centerXmm: 30, centerYmm: 30, widthMm: 20, heightMm: 10, rotationDeg: 90 };
    const job = buildBoardArt(image, { ...base, style, placement });
    expect(job.options.placement).toEqual(placement);
    expect(job.art.clipped.length).toBeGreaterThan(0);
    const silk = parseGerber(job.gerbers.find((g) => g.name === "board-F_Silkscreen.gbr")!.body);
    const points = silk.ops.flatMap((op) =>
      op.op === "flash"
        ? [{ x: op.x, y: op.y }]
        : op.op === "draw"
          ? [
              { x: op.x1, y: op.y1 },
              { x: op.x2, y: op.y2 },
            ]
          : [],
    );
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      expect(p.x).toBeGreaterThanOrEqual(24);
      expect(p.x).toBeLessThanOrEqual(36);
      expect(p.y).toBeGreaterThanOrEqual(19);
      expect(p.y).toBeLessThanOrEqual(41);
    }
    expect(job.previewSvg).toContain('data-layer="silk"');
    expect(job.kicadPcb).toContain("F.SilkS");
  });

test("off-board placement clips to nothing rather than leaking artwork into exports", () => {
  const job = buildBoardArt(image, {
    ...base,
    placement: { centerXmm: -30, centerYmm: -30, widthMm: 10, heightMm: 10, rotationDeg: 45 },
  });
  expect(job.art.clipped).toEqual([]);
});

test("rejects invalid dimensions and normalizes negative rotation", () => {
  const p = { centerXmm: 20, centerYmm: 20, widthMm: 10, heightMm: 10, rotationDeg: -90 };
  expect(resolveArtOptions({ ...base, placement: p }).placement?.rotationDeg).toBe(270);
  expect(() => resolveArtOptions({ ...base, placement: { ...p, widthMm: 0 } })).toThrow();
  expect(() => resolveArtOptions({ ...base, placement: { ...p, centerXmm: NaN } })).toThrow();
});
