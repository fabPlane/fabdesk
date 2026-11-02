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
  test("a board at nominal minimum clearance fails when opposing surface error is enabled", () => {
    const d = design();
    d.space.x = -1;
    const fit = () => checkMechanicalFit(d, boards(d));
    expect(fit().issues.some((i) => i.code === "outside-space")).toBe(false);
    d.fitAllowance = 0.1;
    expect(fit().issues.some((i) => i.code === "outside-space")).toBe(true);
    expect(fit().issues.some((i) => i.code === "fit-allowance" && i.severity === "review")).toBe(
      true,
    );
  });
  test("floor clearance and posts outside the board still protect underside parts", () => {
    const d = design();
    d.space.x = -10;
    d.space.width = 60;
    d.mounts = [{ x: -1, y: 10, diameter: 1, outer: 4, height: 4 }];
    const f = structuredClone(features);
    f.components!.push({
      ref: "J2",
      footprint: "bottom",
      x: 0,
      y: 10,
      heightMm: 2.5,
      bottom: true,
      bounds: { minX: -3, minY: 8, maxX: 2, maxY: 12 },
    });
    const fit = () => checkMechanicalFit(d, [{ placement: d.boards[0]!, features: f }]);
    const report = fit();
    expect(report.issues.some((i) => i.code === "outside-space" && i.message.includes("J2"))).toBe(
      true,
    );
    expect(
      report.issues.some((i) => i.code === "mount-collision" && i.message.includes("J2")),
    ).toBe(true);
    expect(report.issues.some((i) => i.code === "mount-height")).toBe(true);
    d.mounts = [];
    d.boards[0]!.z = 5.5;
    expect(fit().issues.some((i) => i.code === "outside-space")).toBe(false);
    d.boards[0]!.z = 5;
    d.space.clearance = 0;
    expect(fit().issues.some((i) => i.code === "outside-space")).toBe(false);
  });
  test("mounting posts highlight interference with underside components", () => {
    const d = design();
    d.mounts = [{ x: 3, y: 3, diameter: 3, outer: 6, height: 3 }];
    const f = structuredClone(features);
    f.components!.push({
      ref: "U2",
      footprint: "bottom",
      x: 4,
      y: 3,
      heightMm: 3,
      bottom: true,
      bounds: { minX: 3, minY: 2, maxX: 5, maxY: 4 },
    });
    const report = checkMechanicalFit(d, [{ placement: d.boards[0]!, features: f }]);
    expect(report.issues.find((i) => i.code === "mount-collision")).toMatchObject({
      severity: "error",
      regions: [{ name: "Mounting post" }, { name: "U2" }],
    });
    expect(report.status).toBe("blocked");
  });
  test("connector openings follow rotated board bounds and underside heights", () => {
    const d = design();
    d.space = { ...d.space, x: -25, y: -5, width: 30, depth: 50 };
    d.boards[0] = { ...d.boards[0]!, rotation: 90, z: 7 };
    const f = extractBoardFeatures(
      '(kicad_pcb (general (thickness 1.6))(gr_rect (start 0 0)(end 40 20)(layer "Edge.Cuts"))(footprint "Connector_USB:USB_C" (layer "B.Cu")(at 10 0)(property "Reference" "J1")(fp_rect (start -2 -3)(end 2 1)(layer "B.CrtYd"))))',
    );
    expect(f.connectors).toHaveLength(1);
    d.openings = [{ name: "USB", wall: "maxX", offset: 10, z: 3, width: 6, height: 5 }];
    const fit = () => checkMechanicalFit(d, [{ placement: d.boards[0]!, features: f }]);
    expect(fit().issues.some((i) => i.code === "connector-opening")).toBe(false);
    d.openings[0]!.z = 8;
    expect(fit().issues.some((i) => i.code === "connector-opening")).toBe(true);
  });
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
  test("fit highlights locate transformed parts, obstacles and overflow in world millimetres", () => {
    const d = design();
    d.boards[0]!.rotation = 90;
    d.boards[0]!.x = 30;
    d.obstacles = [{ name: "Battery", x: 19, y: 9, z: 6.6, width: 2, depth: 2, height: 4 }];
    const r = checkMechanicalFit(d, boards(d));
    const issue = r.issues.find((i) => i.code === "obstacle" && i.message.includes("R1"))!;
    expect(issue.regions?.map((v) => v.name)).toEqual(["R1", "Battery"]);
    expect(issue.regions![0]!.x).toBeCloseTo(19);
    expect(issue.regions![0]!.y).toBeCloseTo(9);
    expect(r.issues.find((i) => i.code === "outside-space")?.regions?.[0]?.depth).toBeCloseTo(40);
    expect(r.issues.find((i) => i.code === "coverage")?.regions).toBeUndefined();
    d.obstacles = [];
    d.boards[0]!.rotation = 0;
    d.boards[0]!.x = 0;
    expect(
      checkMechanicalFit(d, boards(d))
        .issues.filter((i) => i.severity === "error")
        .flatMap((i) => i.regions ?? []),
    ).toEqual([]);
  });
  test("clearance-only conflicts have highlights and both colliding boards are located", () => {
    const d = design();
    d.obstacles = [{ name: "Near part", x: 11.5, y: 9, z: 6.7, width: 1, depth: 1, height: 2 }];
    expect(
      checkMechanicalFit(d, boards(d)).issues.some(
        (i) => i.code === "obstacle" && i.regions?.[0]?.name === "R1",
      ),
    ).toBe(true);
    d.boards.push({ ...d.boards[0]!, path: "second.kicad_pcb", x: 20 });
    const r = checkMechanicalFit(d, boards(d));
    const regions = r.issues.find((i) => i.code === "board-collision")!.regions!;
    expect(regions.some((v) => v.name === "PCB" && v.x === 0)).toBe(true);
    expect(regions.some((v) => v.name === "PCB" && v.x === 20)).toBe(true);
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
  test("duplicate board paths cannot create ambiguous selection or export identities", () => {
    const d = design();
    d.boards.push({ ...d.boards[0]!, path: "./board.kicad_pcb", x: 50 });
    expect(MechanicalDesignSchema.safeParse(d).success).toBe(false);
  });
});
