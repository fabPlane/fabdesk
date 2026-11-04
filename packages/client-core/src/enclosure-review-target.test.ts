import { expect, test } from "bun:test";
import type { MechanicalDesign, MechanicalFitIssue } from "@fabdesk/protocol";
import { defaultEnclosureDesign, type EnclosureBoardSummary } from "./enclosure-design";
import { enclosureReviewTarget } from "./enclosure-review-target";

const features: EnclosureBoardSummary = {
  pcbRevision: "revision",
  thicknessMm: 1.6,
  outline: { minX: 100, minY: 200, maxX: 140, maxY: 220, widthMm: 40, heightMm: 20 },
  holes: [],
  connectors: [
    {
      ref: "J2",
      x: 138,
      y: 208,
      widthMm: 6,
      heightMm: 4,
      edge: "maxX",
      bounds: { minX: 136, minY: 203, maxX: 143, maxY: 214 },
      face: {
        bounds: { minX: 138, minY: 205, maxX: 142, maxY: 211 },
        heightMm: 3.2,
        centerZ: 1.8,
        source: "fabrication-outline",
      },
    },
    { ref: "J20", x: 110, y: 204, widthMm: 2, heightMm: 2, edge: "minY" },
  ],
  components: [
    {
      ref: "J2",
      x: 138,
      y: 208,
      heightMm: 4,
      bottom: false,
      bounds: { minX: 136, minY: 203, maxX: 143, maxY: 214 },
    },
    {
      ref: "C3",
      x: 103,
      y: 204,
      heightMm: 3,
      bottom: false,
      bounds: { minX: 102, minY: 202, maxX: 104, maxY: 206 },
    },
    {
      ref: "R1",
      x: 130,
      y: 210,
      heightMm: 1,
      bottom: true,
      bounds: { minX: 129, minY: 209, maxX: 131, maxY: 211 },
    },
  ],
};

function fixture() {
  const a = { path: "hardware/J2-controller.kicad_pcb", x: 20, y: -40, z: 8, rotation: 90 };
  const b = { path: "hardware/usb/board.kicad_pcb", x: 300, y: 500, z: 6, rotation: 180 };
  const design: MechanicalDesign = { ...defaultEnclosureDesign(null), boards: [a, b] };
  return {
    design,
    a,
    b,
    // Feature responses may describe a layout predating the current design.
    boards: [a, b].map((p) => ({ placement: { ...p, x: 999, y: -888, rotation: 0 }, features })),
  };
}

function issue(message: string, code = "port-measurements"): MechanicalFitIssue {
  return { code, severity: "review", message };
}

test("connector review points to its face using native PCB coordinates and the current rotated placement", () => {
  const { design, a, boards } = fixture();
  const target = enclosureReviewTarget(
    issue(`${a.path}: J2 dimensions need confirmation.`),
    design,
    boards,
  )!;
  expect(target.kind).toBe("connector");
  expect(target.boardPath).toBe(a.path);
  expect(target.modelId).toBe(`@fit-${a.path}`);
  expect(target.reference).toBe("J2");
  for (const [i, value] of [-188, 102, 11.4].entries()) expect(target.point[i]).toBeCloseTo(value);
  expect(target.regions).toHaveLength(1);
  const box = target.regions[0]!;
  for (const [key, value] of Object.entries({
    x: -191,
    y: 98,
    z: 9.8,
    width: 6,
    depth: 4,
    height: 3.2,
  }))
    expect(box[key as "x" | "y" | "z" | "width" | "depth" | "height"]).toBeCloseTo(value);
});

test("a shared connector reference identifies the correct board in a multi-board layout", () => {
  const { design, b, boards } = fixture();
  const target = enclosureReviewTarget(
    issue(`${b.path}: J2 dimensions need confirmation.`),
    design,
    boards,
  )!;
  expect(target.boardPath).toBe(b.path);
  for (const [i, value] of [158, 292, 9.4].entries()) expect(target.point[i]).toBeCloseTo(value);
});

test("connector references match whole names and never match the board filename", () => {
  const { design, a, boards } = fixture();
  const port = enclosureReviewTarget(issue(`${a.path}: J20 needs checking.`), design, boards)!;
  expect(port.reference).toBe("J20");
  expect(port.regions).toEqual([]); // Known point, no fabricated body extent.
  const board = enclosureReviewTarget(
    issue(`${a.path}: no supporting screw posts.`, "mount-none"),
    design,
    boards,
  )!;
  expect(board.kind).toBe("board");
  expect(board.reference).toBeUndefined();
  for (const [i, value] of [-190, 80, 8.8].entries()) expect(board.point[i]).toBeCloseTo(value);
});

test("bottom-side connector faces remain below the PCB instead of mirroring onto its top", () => {
  const { design, a, boards } = fixture();
  boards[0]!.features = {
    ...features,
    components: features.components!.map((p) => (p.ref === "J2" ? { ...p, bottom: true } : p)),
  };
  const target = enclosureReviewTarget(issue(`${a.path}: J2 needs checking.`), design, boards)!;
  expect(target.point[2]).toBeCloseTo(6.2);
  expect(target.regions[0]!.z).toBeCloseTo(4.6);
});

test("missing component reviews locate their known footprints and retain all implicated part bounds", () => {
  const { design, a, boards } = fixture();
  const target = enclosureReviewTarget(
    issue(`${a.path}: missing bodies for C3, R1.`, "detailed-missing"),
    design,
    boards,
  )!;
  expect(target.kind).toBe("component");
  expect(target.reference).toBe("C3");
  for (const [i, value] of [-184, 63, 11.1].entries()) expect(target.point[i]).toBeCloseTo(value);
  expect(target.regions.map((r) => r.name)).toEqual(["C3", "R1"]);
  expect(target.regions[1]!.z).toBe(7);
});

test("explicit collision regions stay authoritative and are not mutated", () => {
  const { design, boards } = fixture();
  const regions = [
    { name: "Screw", x: 2, y: 3, z: 4, width: 2, depth: 4, height: 6 },
    { name: "Obstacle", x: 30, y: 20, z: 1, width: 5, depth: 8, height: 2 },
  ];
  const finding: MechanicalFitIssue = {
    code: "mount-collision",
    severity: "error",
    message: "Screw intersects a fixed part.",
    regions,
  };
  const before = structuredClone(finding);
  const target = enclosureReviewTarget(finding, design, boards)!;
  expect(target.kind).toBe("regions");
  expect(target.point).toEqual([3, 5, 7]);
  expect(target.regions).toEqual(regions);
  expect(finding).toEqual(before);
});

test("global limitations and unlocated findings never point at an arbitrary case centre", () => {
  const { design, a, boards } = fixture();
  for (const code of [
    "coverage",
    "import-coverage",
    "shell-coverage",
    "detailed-coverage",
    "detailed-layers",
    "assembly-sampled",
    "verification-pending",
  ])
    expect(
      enclosureReviewTarget(issue(`${a.path}: general check limits.`, code), design, boards),
    ).toBeNull();
  expect(
    enclosureReviewTarget(issue("Confirm enclosure dimensions.", "dimensions"), design, boards),
  ).toBeNull();
  expect(
    enclosureReviewTarget(
      { ...issue(`${a.path}: check coverage is incomplete.`, "coverage"), severity: "error" },
      design,
      boards,
    ),
  ).toBeNull();
  expect(
    enclosureReviewTarget(issue("removed.kicad_pcb: J2 needs checking."), design, boards),
  ).toBeNull();
  expect(enclosureReviewTarget(issue(`${a.path}: J2 needs checking.`), design, [])).toBeNull();
});

test("invalid report extents cannot produce non-finite or inverted scene targets", () => {
  const { design, boards } = fixture();
  const finding: MechanicalFitIssue = {
    code: "obstacle",
    severity: "error",
    message: "Invalid source bounds.",
    regions: [
      { name: "Invalid", x: NaN, y: 0, z: 0, width: 5, depth: 5, height: 5 },
      { name: "Inverted", x: 0, y: 0, z: 0, width: -1, depth: 2, height: 2 },
    ],
  };
  expect(enclosureReviewTarget(finding, design, boards)).toBeNull();
});
