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
