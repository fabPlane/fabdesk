import { expect, test } from "bun:test";
import { defaultEnclosureDesign, type EnclosureBoardSummary } from "./enclosure-design";

test("new enclosure defaults include overhangs, underside parts and connector clearance", () => {
  const board: EnclosureBoardSummary = {
    pcbRevision: "a".repeat(64),
    thicknessMm: 1.6,
    outline: { minX: 0, minY: 0, maxX: 40, maxY: 20, widthMm: 40, heightMm: 20 },
    holes: [{ x: 3, y: 3, diameterMm: 3 }],
    components: [
      {
        ref: "U1",
        x: 30,
        y: 10,
        heightMm: 9,
        bottom: true,
        bounds: { minX: 28, minY: 8, maxX: 32, maxY: 12 },
      },
      {
        ref: "U2",
        x: 20,
        y: 15,
        heightMm: 22,
        bottom: false,
        bounds: { minX: 18, minY: 13, maxX: 22, maxY: 17 },
      },
      {
        ref: "J1",
        x: 0,
        y: 10,
        heightMm: 3.6,
        bottom: false,
        bounds: { minX: -4, minY: 8, maxX: 2, maxY: 12 },
      },
    ],
    connectors: [
      {
        ref: "J1",
        edge: "minX",
        x: 0,
        y: 10,
        widthMm: 4,
        heightMm: 3.6,
        bounds: { minX: -4, minY: 8, maxX: 2, maxY: 12 },
      },
    ],
  };
  const d = defaultEnclosureDesign(board),
    z = d.boards[0]!.z;
  expect(d.space.x).toBe(-6);
  expect(d.space.width).toBe(48);
  expect(z - 9).toBeGreaterThanOrEqual(d.space.floor + d.space.clearance);
  expect(d.space.floor + d.space.height).toBeCloseTo(z + 1.6 + 22 + d.space.clearance);
  expect(d.mounts[0]!.height).toBe(z - d.space.floor);
  expect(d.openings[0]!.width).toBe(4 + 2 * d.space.clearance);
  expect(d.confirmed).toBe(false);
  board.components![2]!.bottom = true;
  const bottom = defaultEnclosureDesign(board);
  expect(bottom.openings[0]!.z).toBeCloseTo(bottom.boards[0]!.z - 3.6 - bottom.space.clearance);
});

test("connector suggestions use body centre rather than an off-centre footprint origin", () => {
  const d = defaultEnclosureDesign({
    pcbRevision: "b".repeat(64),
    thicknessMm: 1.6,
    holes: [],
    outline: { minX: 0, minY: 0, maxX: 40, maxY: 20, widthMm: 40, heightMm: 20 },
    connectors: [
      {
        ref: "J1",
        edge: "minY",
        x: 10,
        y: 0,
        widthMm: 8,
        heightMm: 4,
        bounds: { minX: 10, minY: -2, maxX: 18, maxY: 2 },
      },
    ],
  });
  expect(d.openings[0]!.offset).toBe(14);
});
