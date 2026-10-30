import { expect, test } from "bun:test";
import { defaultEnclosureDesign, type EnclosureBoardSummary } from "./enclosure-design";
import {
  alignEnclosureMounts,
  mountingCandidates,
  mountAtHole,
  linkEnclosureMounts,
} from "./enclosure-mounts";
const features: EnclosureBoardSummary = {
  pcbRevision: "r",
  thicknessMm: 1.6,
  outline: { minX: 0, minY: 0, maxX: 30, maxY: 20, widthMm: 30, heightMm: 20 },
  holes: [
    { id: "H1", ref: "H1", x: 3, y: 4, diameterMm: 2.2, shape: "round", purpose: "mounting" },
    { id: "J1", x: 10, y: 10, diameterMm: 1, purpose: "component" },
    { id: "slot", x: 20, y: 5, diameterMm: 3, shape: "slot", purpose: "mounting" },
  ],
};
test("six PCBs keep separate linked posts through translation, rotation and floor changes", () => {
  let design = defaultEnclosureDesign(features);
  design.boards = Array.from({ length: 6 }, (_, i) => ({
    path: `board-${i}.kicad_pcb`,
    x: i * 50,
    y: 10,
    z: 8,
    rotation: i * 45,
  }));
  const boards = design.boards.map((placement) => ({ placement, features }));
  expect(mountingCandidates(features)).toHaveLength(1);
  design.mounts = boards.map((b) => mountAtHole(b, features.holes[0]!, design.space.floor));
  design.mounts.push({ x: -20, y: -20, diameter: 2, outer: 5, height: 3 });
  design.space.floor = 3;
  for (const b of boards) {
    b.placement.x += 7;
    b.placement.rotation += 30;
    b.placement.z = 9;
  }
  design = alignEnclosureMounts(design, boards);
  for (const [i, b] of boards.entries()) {
    const a = (b.placement.rotation * Math.PI) / 180;
    expect(design.mounts[i]!.x).toBeCloseTo(b.placement.x + 3 * Math.cos(a) - 4 * Math.sin(a));
    expect(design.mounts[i]!.y).toBeCloseTo(b.placement.y + 3 * Math.sin(a) + 4 * Math.cos(a));
    expect(design.mounts[i]!.height).toBe(6);
    expect(design.mounts[i]!.boardPath).toBe(b.placement.path);
  }
  expect(design.mounts[6]).toEqual({ x: -20, y: -20, diameter: 2, outer: 5, height: 3 });
});
test("existing posts link only to unique round mounting holes", () => {
  const d = defaultEnclosureDesign(features);
  d.mounts = [
    { x: 3, y: 4, diameter: 2, outer: 5, height: 3 },
    { x: 10, y: 10, diameter: 1, outer: 4, height: 3 },
  ];
  const b = { placement: d.boards[0]!, features };
  const linked = linkEnclosureMounts(d, [b]);
  expect(linked.mounts[0]!.holeId).toBe("H1");
  expect(linked.mounts[1]!.holeId).toBeUndefined();
  expect(
    linkEnclosureMounts(d, [b, { ...b, placement: { ...b.placement, path: "other.kicad_pcb" } }])
      .mounts[0]!.holeId,
  ).toBeUndefined();
});
