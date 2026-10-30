import { expect, test } from "bun:test";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { extractBoardFeatures } from "../src/board-features";
import { enclosureHardware } from "../src/enclosure-hardware";
import {
  boardVolumes,
  boxesOverlap,
  checkMechanicalFit,
  enclosureFromDesign,
} from "../src/mechanical-fit";
import { joinedEnclosure, enclosureFitSamples, auditStl } from "../src/enclosure-solid";
import { readStlTriangles } from "../src/shell-fit";
import { MechanicalDesignSchema } from "@fabdesk/protocol";

function fixture(rotation = 0) {
  const d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.space = {
    x: 0,
    y: 0,
    width: 120,
    depth: 120,
    floor: 2,
    height: 18,
    lid: 2,
    wall: 2,
    clearance: 1,
  };
  d.boards = [{ path: "board.kicad_pcb", x: 50, y: 50, z: 5, rotation }];
  d.holders = [{ boardPath: "board.kicad_pcb", kind: "edge-clamps" }];
  d.closure = {
    kind: "screws",
    screwDiameter: 3,
    screwLength: 8,
    pilotDiameter: 2.5,
    clearanceDiameter: 3.4,
    bossDiameter: 8,
  };
  const f = extractBoardFeatures(
    '(kicad_pcb (general(thickness 1))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts")))',
  );
  f.components = [
    [0, 0],
    [34, 0],
    [0, 14],
    [34, 14],
  ].map(([x, y], i) => ({
    ref: `J${i + 1}`,
    footprint: "Corner connector",
    x: x!,
    y: y!,
    heightMm: 5,
    bounds: { minX: x!, minY: y!, maxX: x! + 6, maxY: y! + 6 },
    bottom: false,
  }));
  return { d, boards: [{ placement: d.boards[0]!, features: f }] };
}

test.each([0, 90, 180, 270])(
  "edge supports avoid occupied corners after %i degree rotation",
  async (rotation) => {
    const { d, boards } = fixture(rotation);
    expect(MechanicalDesignSchema.parse(d).holders![0]!.kind).toBe("edge-clamps");
    const hardware = enclosureHardware(d, boards);
    expect(hardware.issues.filter((i) => i.severity === "error")).toEqual([]);
    const captures = hardware.solids.filter((s) => s.name.startsWith("EdgeCapture"));
    expect(captures).toHaveLength(4);
    expect(hardware.solids.filter((s) => s.name.startsWith("EdgeStop"))).toHaveLength(2);
    const [pcb, ...components] = boardVolumes(boards[0]!);
    for (const solid of hardware.solids.filter((s) => s.name.startsWith("Edge"))) {
      const r = {
        name: solid.name,
        x: solid.min.x,
        y: solid.min.y,
        z: solid.min.z,
        width: solid.max.x - solid.min.x,
        depth: solid.max.y - solid.min.y,
        height: solid.max.z - solid.min.z,
      };
      expect(components.some((c) => boxesOverlap(r, c))).toBe(false);
      expect(boxesOverlap(r, pcb!)).toBe(false);
    }
    // Boolean exports include all new hardware in the closed case/lid solids.
    const result = await joinedEnclosure(enclosureFromDesign(d, boards));
    expect(result.validation.base.components).toBe(1);
    expect(result.validation.lid.components).toBe(1);
  },
);

test("blocked end stops, underside parts and screw holes cannot be relaxed by the holder search", () => {
  const { d, boards } = fixture();
  d.obstacles = [{ name: "Plug path", x: 47, y: 47, z: 2, width: 4, depth: 26, height: 18 }];
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-space")).toBe(true);
  d.obstacles = [];
  boards[0]!.features.components!.push({
    ref: "Bottom shield",
    footprint: "Shield",
    x: 0,
    y: 0,
    heightMm: 2,
    bottom: true,
    bounds: { minX: 0, minY: 0, maxX: 40, maxY: 20 },
  });
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-space")).toBe(true);
  boards[0]!.features.components = [];
  boards[0]!.features.holes = [
    { id: "slot", x: 20, y: 10, diameterMm: 50, source: "npth-pad", shape: "round" },
  ];
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-space")).toBe(true);
});

test("edge holders require a screwed lid, adequate PCB engagement and case space", () => {
  const { d, boards } = fixture();
  d.closure!.kind = "lift-off";
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-closure")).toBe(true);
  d.closure!.kind = "screws";
  boards[0]!.features.thicknessMm = 0.3;
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-space")).toBe(true);
  boards[0]!.features.thicknessMm = 1;
  d.space.x = 50;
  d.space.width = 40;
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-space")).toBe(true);
});

test("edge-fit sample preserves the board thickness and capture profile in a closed printable solid", async () => {
  const { d, boards } = fixture();
  const files = await enclosureFitSamples(d, boards);
  const bytes = new TextEncoder().encode(files["fit-samples/edge-holder-01.stl"]!);
  const audit = await auditStl(bytes);
  expect(audit.components).toBe(1);
  expect(audit.volumeMm3).toBeCloseTo(102, 3);
  const triangles = readStlTriangles(bytes);
  const z = Array.from(triangles).filter((_, i) => i % 3 === 2);
  expect(Math.min(...z)).toBeCloseTo(0, 5);
  expect(Math.max(...z)).toBeCloseTo(8, 5);
  expect(files["fit-samples/README.txt"]).toContain(
    "1 mm PCB + 0.25 mm vertical play, 0.5 mm capture lip",
  );
  expect(files["fit-samples/README.txt"]).toContain("load-test the complete screwed-lid case");
});
