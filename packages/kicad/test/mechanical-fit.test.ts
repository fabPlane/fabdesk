import { describe, expect, test } from "bun:test";
import { MechanicalDesignSchema, type MechanicalDesign } from "@fabdesk/protocol";
import { extractBoardFeatures } from "../src/board-features";
import { boardVolumes, checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { meshEnclosure } from "../src/enclosure";

const pcb = `(kicad_pcb (general (thickness 1.6))
 (gr_rect (start 0 0)(end 40 20)(layer "Edge.Cuts"))
 (footprint "R_0402" (layer "F.Cu")(at 10 10)(property "Reference" "R1")
   (fp_rect (start -1 -1)(end 1 1)(layer "F.CrtYd")))
 (footprint "MountingHole" (layer "F.Cu")(at 3 3)(property "Reference" "H1")
   (pad "" np_thru_hole circle (at 0 0)(size 3 3)(drill 3)))
)`;
const features = extractBoardFeatures(pcb);
const design = (): MechanicalDesign => ({
  version: 1,
  mode: "generated",
  source: null,
  confirmed: true,
  space: {
    x: -2,
    y: -2,
    width: 44,
    depth: 24,
    height: 20,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  },
  boards: [{ path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }],
  obstacles: [],
  mounts: [],
  openings: [],
});
const boards = (d: MechanicalDesign) => d.boards.map((placement) => ({ placement, features }));
describe("mechanical fit constraints", () => {
  test("includes low-profile components and standard NPTH drill dimensions", () => {
    expect(features.components?.some((p) => p.ref === "R1")).toBe(true);
    expect(features.holes.find((h) => h.ref === "H1")?.diameterMm).toBe(3);
    expect(checkMechanicalFit(design(), boards(design())).status).toBe("review");
  });
  test("finds interior clearance and obstacle conflicts including short components", () => {
    const d = design();
    d.obstacles = [{ name: "Battery", x: 9, y: 9, z: 6.6, width: 2, depth: 2, height: 4 }];
    const r = checkMechanicalFit(d, boards(d));
    expect(r.issues.some((i) => i.code === "obstacle" && i.message.includes("R1"))).toBe(true);
    d.space.width = 39;
    expect(checkMechanicalFit(d, boards(d)).issues.some((i) => i.code === "outside-space")).toBe(
      true,
    );
  });
  test("rotates and translates envelopes in the shared PCB frame", () => {
    const d = design();
    d.boards[0]!.rotation = 90;
    d.boards[0]!.x = 30;
    const v = boardVolumes(boards(d)[0]!)[0]!;
    expect(v.x).toBeCloseTo(10);
    expect(v.width).toBeCloseTo(20);
    expect(v.depth).toBeCloseTo(40);
  });
  test("detects overlapping boards and mounting posts without matching holes", () => {
    const d = design();
    d.boards.push({ ...d.boards[0]!, path: "second.kicad_pcb" });
    d.mounts = [{ x: 10, y: 10, diameter: 3, outer: 6, height: 4 }];
    const codes = checkMechanicalFit(d, boards(d)).issues.map((i) => i.code);
    expect(codes).toContain("board-collision");
    expect(codes).toContain("mount-hole");
    expect(codes).toContain("mount-height");
  });
  test("uses confirmed dimensions, cuts openings and gives each post its requested height", () => {
    const d = design();
    d.space.width = 80;
    d.space.depth = 45;
    d.space.height = 30;
    d.mounts = [{ x: 3, y: 3, diameter: 3, outer: 6, height: 3 }];
    d.openings = [{ name: "USB", wall: "minY", offset: 10, z: 7, width: 12, height: 6 }];
    const spec = enclosureFromDesign(d, boards(d));
    expect(spec.inner.maxX - spec.inner.minX).toBe(80);
    expect(spec.inner.z1 - spec.inner.z0).toBe(30);
    expect(spec.cutouts[0]?.widthMm).toBe(12);
    const post = spec.solids.find((s) => s.role === "standoff")!;
    expect(post.max.z - post.min.z).toBe(3);
    const mesh = meshEnclosure(spec);
    expect(mesh.baseStl).toContain("facet normal");
    expect(mesh.step).toContain("ISO-10303-21");
  });
  test("never describes approximate checks as verified collision-free", () => {
    const d = design();
    d.mode = "imported";
    d.source = { path: "case.stl", scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] };
    const r = checkMechanicalFit(d, boards(d));
    expect(r.status).toBe("review");
    expect(r.issues.some((i) => i.code === "import-coverage")).toBe(true);
  });
  test("rejects nonfinite sizes, invalid paths and hollow-post inversions", () => {
    const d = design();
    d.space.width = NaN;
    expect(MechanicalDesignSchema.safeParse(d).success).toBe(false);
    const p = design();
    p.boards[0]!.path = "../board.kicad_pcb";
    expect(MechanicalDesignSchema.safeParse(p).success).toBe(false);
    p.boards = [];
    p.mounts = [{ x: 1, y: 1, diameter: 6, outer: 3, height: 3 }];
    expect(MechanicalDesignSchema.safeParse(p).success).toBe(false);
  });
});
