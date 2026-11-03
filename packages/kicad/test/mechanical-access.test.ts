import { expect, test } from "bun:test";
import { MechanicalDesignSchema, portEnvelopes, cableAssessments } from "@fabdesk/protocol";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";
import { extractBoardFeatures } from "../src/board-features";
import { checkMechanicalFit } from "../src/mechanical-fit";
const f = () =>
  extractBoardFeatures(
    `(kicad_pcb(general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts"))(footprint "Connector_USB:USB_C"(layer "F.Cu")(at 0 10)(property "Reference" "J1")(fp_rect(start -1 -4)(end 5 4)(layer "F.CrtYd"))))`,
  );
function fixture() {
  const features = f(),
    d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.boards = [
    { path: "a.kicad_pcb", x: 2, y: 2, z: 6, rotation: 0 },
    { path: "b.kicad_pcb", x: 2, y: 40, z: 6, rotation: 0 },
  ];
  d.space.width = 100;
  d.space.depth = 100;
  return { d, boards: d.boards.map((placement) => ({ placement, features })) };
}

test("connector protrusion reduces required plug reach instead of increasing it", () => {
  const { d, boards } = fixture();
  const b = boards[0]!;
  d.boards = [b.placement];
  b.placement.x = -0.5; // minX body face is 1.5 mm into a 2 mm wall.
  d.portAccess = [
    {
      boardPath: b.placement.path,
      ref: "J1",
      access: "external",
      plug: { width: 8, height: 4, depth: 10, reach: 1 },
    },
  ];
  const port = portEnvelopes(d, [b])[0]!;
  expect(port.gap).toBeCloseTo(-1.5);
  expect(port.gap + d.space.wall).toBeCloseTo(0.5);
  expect(checkMechanicalFit(d, [b]).issues.filter((i) => i.code === "plug-reach")).toEqual([]);
  b.placement.x = 2;
  expect(checkMechanicalFit(d, [b]).issues.some((i) => i.code === "plug-reach")).toBe(true);
});

test("nearby openings warn about thin material while separated ports do not", () => {
  const { d, boards } = fixture();
  d.openings = [
    { name: "USB", wall: "minY", offset: 20, z: 7, width: 10, height: 4 },
    { name: "Card", wall: "minY", offset: 30.1, z: 7, width: 10, height: 4 },
  ];
  expect(checkMechanicalFit(d, boards).issues.filter((i) => i.code === "opening-web")).toHaveLength(
    1,
  );
  d.openings[1]!.offset = 40;
  expect(checkMechanicalFit(d, boards).issues.filter((i) => i.code === "opening-web")).toHaveLength(
    0,
  );
  d.openings[1]!.z = d.space.floor + d.space.height - 4.1;
  expect(
    checkMechanicalFit(d, boards).issues.some(
      (i) => i.code === "opening-web" && i.severity === "review",
    ),
  ).toBe(true);
});
test("cable endpoints, allowance and stale references are validated by the fit checker", () => {
  const { d, boards } = fixture();
  d.connections = [
    {
      id: "c",
      from: { boardPath: "a.kicad_pcb", ref: "J1" },
      to: { boardPath: "b.kicad_pcb", ref: "J1" },
      length: 45,
      slack: 10,
    },
  ];
  expect(cableAssessments(d, boards)[0]!.distance).toBeCloseTo(38);
  expect(
    checkMechanicalFit(d, boards).issues.some(
      (i) => i.code === "cable-length" && i.severity === "error",
    ),
  ).toBe(true);
  d.connections[0]!.length = 50;
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "cable-length")).toBe(false);
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "cable-routing")).toBe(true);
  d.connections[0]!.to.ref = "deleted";
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "cable-endpoint")).toBe(true);
});
test("measured aperture, plug body and mating reach are checked independently", () => {
  const { d, boards } = fixture();
  d.boards = d.boards.slice(0, 1);
  d.portAccess = [
    {
      boardPath: "a.kicad_pcb",
      ref: "J1",
      access: "external",
      face: "minX",
      wall: "minX",
      aperture: { width: 6, height: 2 },
      plug: { width: 12, height: 8, depth: 20, reach: 5 },
    },
  ];
  d.openingClearance = 0.3;
  const p = proposeEnclosureLayout(d, boards.slice(0, 1));
  const placed = [{ ...boards[0]!, placement: p.design.boards[0]! }];
  const codes = () => checkMechanicalFit(p.design, placed).issues.map((i) => i.code);
  expect(codes()).not.toContain("connector-opening");
  expect(codes()).not.toContain("plug-reach");
  expect(codes()).toContain("port-measurements");
  p.design.portAccess![0]!.aperture!.evidence = {
    kind: "measured",
    reference: "Synthetic connector measurement fixture",
  };
  p.design.portAccess![0]!.plug!.evidence = {
    kind: "datasheet",
    reference: "Synthetic plug drawing fixture",
  };
  expect(codes()).not.toContain("port-measurements");
  const envelope = portEnvelopes(p.design, placed)[0]!;
  expect(envelope.plug!.x + envelope.plug!.width).toBeCloseTo(
    p.design.space.x - p.design.space.wall,
  );
  p.design.portAccess![0]!.plug!.reach = 0;
  expect(codes()).toContain("plug-reach");
  p.design.portAccess![0]!.plug!.reach = 5;
  p.design.obstacles = [{ ...envelope.plug!, name: "External obstruction" }];
  expect(codes()).toContain("plug-collision");
  p.design.portAccess![0]!.wall = "maxX";
  expect(codes()).toContain("port-wall");
});
test("a recessed socket keeps its aligned opening while actual mating reach remains enforced", () => {
  const { d, boards } = fixture();
  d.boards = d.boards.slice(0, 1);
  d.boards[0]!.x = 10;
  d.portAccess = [
    {
      boardPath: "a.kicad_pcb",
      ref: "J1",
      access: "external",
      aperture: { width: 8, height: 3.6 },
      plug: { width: 10, height: 6, depth: 10, reach: 20 },
    },
  ];
  d.openings = [
    {
      name: "Recessed USB",
      boardPath: "a.kicad_pcb",
      ref: "J1",
      wall: "minX",
      offset: 12,
      z: 7.2,
      width: 8.8,
      height: 4.4,
    },
  ];
  const codes = () => checkMechanicalFit(d, boards.slice(0, 1)).issues.map((i) => i.code);
  expect(codes()).not.toContain("connector-opening");
  expect(codes()).not.toContain("plug-reach");
  d.portAccess[0]!.plug!.reach = 2;
  expect(codes()).toContain("plug-reach");
  delete d.portAccess[0]!.plug;
  expect(codes()).toContain("port-measurements");
  d.openings[0]!.offset += 4;
  expect(codes()).toContain("connector-opening");
});

test("overlapping plug bodies are flagged even when both PCBs fit inside", () => {
  const { d, boards } = fixture();
  d.portAccess = d.boards.map((b) => ({
    boardPath: b.path,
    ref: "J1",
    access: "external",
    plug: { width: 50, height: 8, depth: 20, reach: 5 },
  }));
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "plug-collision")).toBe(true);
});

test("removal travel reserves free space beyond the inserted plug", () => {
  const { d, boards } = fixture();
  d.boards = d.boards.slice(0, 1);
  d.portAccess = [
    {
      boardPath: d.boards[0]!.path,
      ref: "J1",
      access: "external",
      plug: { width: 10, height: 6, depth: 10, reach: 5 },
    },
  ];
  const p = portEnvelopes(d, boards.slice(0, 1))[0]!.plug!;
  d.obstacles = [
    { name: "Card removal obstruction", x: p.x - 8, y: p.y, z: p.z, width: 3, depth: 3, height: 3 },
  ];
  expect(
    checkMechanicalFit(d, boards.slice(0, 1)).issues.some((i) => i.code === "plug-collision"),
  ).toBe(false);
  d.portAccess[0]!.plug!.travel = 10;
  expect(
    checkMechanicalFit(d, boards.slice(0, 1)).issues.some((i) => i.code === "plug-collision"),
  ).toBe(true);
});
test("new constraints round-trip while invalid sizes are rejected", () => {
  const { d } = fixture();
  d.boards[0]!.locked = true;
  d.portAccess = [
    {
      boardPath: "a.kicad_pcb",
      ref: "J1",
      access: "external",
      plug: { width: 12, height: 8, depth: 20, reach: 4 },
    },
  ];
  d.connections = [
    {
      id: "c",
      from: { boardPath: "a.kicad_pcb", ref: "J1" },
      to: { boardPath: "b.kicad_pcb", ref: "J1" },
      length: 100,
      slack: 10,
    },
  ];
  d.openingClearance = 0.3;
  expect(MechanicalDesignSchema.parse(d)).toEqual(d);
  d.portAccess[0]!.plug!.depth = -1;
  expect(MechanicalDesignSchema.safeParse(d).success).toBe(false);
});
