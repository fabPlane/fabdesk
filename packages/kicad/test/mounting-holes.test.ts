import { expect, test } from "bun:test";
import { extractBoardFeatures } from "../src/board-features";
import { generateEnclosure, meshEnclosure } from "../src/enclosure";
import { checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";
import type { MechanicalDesign } from "@fabdesk/protocol";

const pcb = `(kicad_pcb (general(thickness 1.6))(gr_rect(start 0 0)(end 50 30)(layer "Edge.Cuts"))
(footprint "MountingHole:3.2mm_Pad"(layer "F.Cu")(at 10 10 90)(property "Reference" "H1")
 (pad "1" thru_hole oval(at 2 3 90)(size 5 6)(drill 3.2(offset 1 0))))
(footprint "MountingHole:2.2mm"(layer "F.Cu")(at 40 24)(property "Reference" "H2")
 (pad "" np_thru_hole circle(at 0 0)(size 2.2 2.2)(drill 2.2)))
(footprint "MountingHole:Slot"(layer "F.Cu")(at 20 22)(property "Reference" "H3")
 (pad "" np_thru_hole oval(at 0 0)(size 2 4)(drill oval 2 4))))`;
test("round plated/NPTH and slot coordinates match KiCad 10.0.5 Excellon output", () => {
  const f = extractBoardFeatures(pcb);
  expect(f.holes.map((h) => [h.x, h.y, h.diameterMm, h.shape])).toEqual([
    [13, 8, 3.2, "round"],
    [40, 24, 2.2, "round"],
    [20, 22, 2, "slot"],
  ]);
  expect(generateEnclosure(f).standoffs.map((s) => [s.x, s.y, s.innerDiameterMm])).toEqual([
    [13, 8, 3.2],
    [40, 24, 2.2],
  ]);
});
test("DNP holes remain physical; connector pins and missing drills never become automatic posts", () => {
  const f = extractBoardFeatures(`(kicad_pcb(gr_rect(start 0 0)(end 50 30)(layer "Edge.Cuts"))
    (footprint "Connector"(layer "F.Cu")(at 20 15)(attr dnp)(property "Reference" "J1")
      (pad "1" thru_hole circle(at 0 0)(size 3 3)(drill 1)))
    (footprint "MountingHole"(layer "F.Cu")(at 5 5)(property "Reference" "H1")
      (pad "" np_thru_hole circle(at 0 0)(size 6 6))))`);
  expect(f.holes).toHaveLength(1);
  expect(f.holes[0]).toMatchObject({ purpose: "component", diameterMm: 1, x: 20, y: 15 });
  expect(generateEnclosure(f).standoffs).toEqual([]);
  expect(f.warnings.some((w) => w.includes("no screw mount inferred"))).toBe(true);
});
function setup() {
  const features = extractBoardFeatures(pcb);
  const design: MechanicalDesign = {
    version: 1,
    mode: "generated",
    source: null,
    confirmed: true,
    space: {
      x: -4,
      y: -4,
      width: 58,
      depth: 38,
      height: 20,
      floor: 2,
      wall: 2,
      lid: 2,
      clearance: 1,
    },
    boards: [{ path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }],
    obstacles: [],
    openings: [],
    mounts: [
      {
        x: 13,
        y: 8,
        diameter: 3.2,
        outer: 6,
        height: 3,
        boardPath: "board.kicad_pcb",
        holeId: "H1-pth-0",
        headDiameter: 6,
        headHeight: 2,
      },
    ],
  };
  const boards = [{ placement: design.boards[0]!, features }];
  return {
    features,
    design,
    boards,
    codes: () =>
      checkMechanicalFit(design, boards)
        .issues.filter((i) => i.severity === "error")
        .map((i) => i.code),
  };
}
test("screw posts reject misalignment, support gaps, oversized bores and small heads", () => {
  const { design: d, codes } = setup();
  expect(codes()).toEqual([]);
  d.mounts[0]!.x += 0.1;
  expect(codes()).toContain("mount-hole");
  d.mounts[0]!.x -= 0.1;
  d.mounts[0]!.height = 2;
  expect(codes()).toContain("mount-support");
  d.mounts[0]!.height = 3;
  d.mounts[0]!.diameter = 3.4;
  expect(codes()).toContain("mount-hole");
  d.mounts[0]!.diameter = 3.2;
  d.mounts[0]!.headDiameter = 3;
  expect(codes()).toContain("screw-head-size");
  d.mounts[0]!.headDiameter = 6;
  d.mounts[0]!.screwDiameter = 3.5;
  expect(codes()).toContain("screw-shaft");
  d.mounts[0]!.screwDiameter = 3;
  d.mounts[0]!.screwLength = 6;
  expect(codes()).toContain("screw-length");
  d.mounts[0]!.screwLength = 1;
  expect(codes()).toContain("screw-length");
  d.mounts[0]!.screwLength = 4;
  expect(codes()).toEqual([]);
});
test("screw head collisions, lid clearance, overlapping posts and missing linked holes block export", () => {
  const { design: d, boards, codes } = setup();
  d.mounts[0]!.headHeight = 18;
  expect(codes()).toContain("screw-head-clearance");
  d.mounts[0]!.headHeight = 2;
  d.obstacles = [{ name: "Cable", x: 11, y: 6, z: 7, width: 4, depth: 4, height: 2 }];
  expect(codes()).toContain("screw-head-clearance");
  d.obstacles = [];
  d.mounts.push({ ...d.mounts[0]! });
  expect(codes()).toContain("mount-overlap");
  d.mounts.pop();
  boards[0]!.features.holes = [];
  expect(codes()).toContain("mount-hole");
});
test("generated STL has an open bore above the floor and solid supporting annulus", () => {
  const { design, boards } = setup();
  const spec = enclosureFromDesign(design, boards);
  const { baseStl, step } = meshEnclosure(spec);
  const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(baseStl)));
  const probe = (x: number, y: number) => ({
    name: "probe",
    x: x - 0.01,
    y: y - 0.01,
    z: 2.01,
    width: 0.02,
    depth: 0.02,
    height: 3.1,
  });
  expect(surface.intersects(probe(13, 8))).toBe(false);
  expect(surface.intersects(probe(15.2, 8))).toBe(true);
  expect(step).toContain("CYLINDRICAL_SURFACE");
});
test("a mounted board never hides an unsecured board in the same enclosure", () => {
  const { design, boards, features } = setup();
  const placement = { path: "unsecured.kicad_pcb", x: 70, y: 0, z: 5, rotation: 0 };
  design.space.width = 130;
  design.boards.push(placement);
  boards.push({ placement, features: { ...features, holes: [] } });
  const findings = checkMechanicalFit(design, boards).issues.filter((i) => i.code === "mount-none");
  expect(findings).toHaveLength(1);
  expect(findings[0]!.message).toStartWith("unsecured.kicad_pcb:");
  expect(findings[0]!.regions?.[0]?.x).toBe(70);
});
