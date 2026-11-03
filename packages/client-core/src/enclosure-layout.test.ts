import { expect, test } from "bun:test";
import { MechanicalDesignSchema, cableAssessments } from "@fabdesk/protocol";
import { defaultEnclosureDesign } from "./enclosure-design";
import {
  proposeEnclosureLayout,
  nativeEnclosureClearanceIssues,
  type LayoutBoard,
} from "./enclosure-layout";
const fixture = (path: string): LayoutBoard => ({
  placement: { path, x: 100, y: 100, z: 6, rotation: 0 },
  features: {
    pcbRevision: path,
    thicknessMm: 1.6,
    outline: { minX: 0, minY: 0, maxX: 40, maxY: 20, widthMm: 40, heightMm: 20 },
    holes: [{ id: "h", x: 5, y: 5, diameterMm: 2.2, purpose: "mounting", shape: "round" }],
    components: [],
    connectors: [
      {
        ref: "USB",
        footprint: "Connector_USB:USB_C",
        edge: "minX",
        x: 0,
        y: 10,
        widthMm: 8,
        heightMm: 3,
        bounds: { minX: -1, minY: 6, maxX: 5, maxY: 14 },
      },
      {
        ref: "FFC",
        footprint: "Connector_FFC",
        edge: "maxY",
        x: 20,
        y: 20,
        widthMm: 10,
        heightMm: 2,
        bounds: { minX: 15, minY: 17, maxX: 25, maxY: 20 },
      },
    ],
  },
});

test("slim boards get a tight rectangular case instead of spare square space", () => {
  const b = fixture("dongle.kicad_pcb");
  b.features.connectors = [];
  b.features.outline = { minX: 0, minY: 0, maxX: 63.2, maxY: 9.1, widthMm: 63.2, heightMm: 9.1 };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.space.clearance = 1;
  const p = proposeEnclosureLayout(d, [b]);
  expect([p.design.space.width, p.design.space.depth].sort((a, b) => a - b)).toEqual([12, 66]);
});

test("tiny boards grow only the case span needed for four lid screws", () => {
  const b = fixture("tiny.kicad_pcb");
  b.features.connectors = [];
  b.features.holes = [];
  b.features.outline = { minX: 0, minY: 0, maxX: 5, maxY: 5, widthMm: 5, heightMm: 5 };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.closure = {
    kind: "screws",
    screwDiameter: 3,
    screwLength: 8,
    pilotDiameter: 2.5,
    clearanceDiameter: 3.4,
    bossDiameter: 8,
  };
  const p = proposeEnclosureLayout(d, [b]);
  expect([p.design.space.width, p.design.space.depth].sort((a, b) => a - b)).toEqual([7, 20]);
  expect(p.design.closure).toEqual(d.closure);
  d.layoutLimit = { width: 25.4, depth: 24 };
  const limited = proposeEnclosureLayout(d, [b]);
  expect(limited.design.space.width).toBeCloseTo(7, 8);
  expect(limited.design.space.depth).toBe(20);
});

test("an exact print limit is tested even when its interior is not on the search grid", () => {
  const b = fixture("small.kicad_pcb");
  b.features.connectors = [];
  b.features.outline = { minX: 0, minY: 0, maxX: 10.3, maxY: 7.3, widthMm: 10.3, heightMm: 7.3 };
  const d = defaultEnclosureDesign(null);
  d.space.clearance = 1;
  d.boards = [b.placement];
  d.layoutLimit = { width: 16.4, depth: 13.4 };
  const p = proposeEnclosureLayout(d, [b]);
  expect(p.design.space.width).toBeCloseTo(12.4);
  expect(p.design.space.depth).toBeCloseTo(9.4);
  expect(p.design.boards[0]!.locked).toBeUndefined();
});

test("rearranging retains a usable fractional case size instead of rounding it up", () => {
  const b = fixture("small.kicad_pcb");
  b.features.connectors = [];
  b.features.outline = { minX: 0, minY: 0, maxX: 10.3, maxY: 7.3, widthMm: 10.3, heightMm: 7.3 };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.space.width = 12.4;
  d.space.depth = 9.4;
  const p = proposeEnclosureLayout(d, [b]);
  expect(p.design.space.width).toBe(12.4);
  expect(p.design.space.depth).toBe(9.4);
  expect(proposeEnclosureLayout(p.design, [b]).design).toEqual(p.design);
});

test("padded courtyards cannot falsely count a recessed connector as reaching its wall", () => {
  const b = fixture("recessed.kicad_pcb");
  const c = b.features.connectors![0]!;
  b.features.connectors = [c];
  c.face = {
    bounds: { minX: 10, maxX: 12, minY: 6, maxY: 14 },
    heightMm: 3,
    centerZ: 1.5,
    source: "fabrication-outline",
  };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  const p = proposeEnclosureLayout(d, [b]);
  expect(p.openingsAdded).toBe(0);
  expect(p.unresolved).toHaveLength(1);
  expect(p.design.openings).toHaveLength(0);
  d.portAccess = [
    {
      boardPath: b.placement.path,
      ref: c.ref,
      access: "external",
      plug: { width: 8, height: 4, depth: 10, reach: 15 },
    },
  ];
  const reachable = proposeEnclosureLayout(d, [b]);
  expect(reachable.openingsAdded).toBe(1);
  expect(reachable.unresolved).toEqual([]);
  expect(reachable.design.openings).toHaveLength(1);
});
test("layout reserves dimensional allowance in rounded openings and native clearance", () => {
  const b = fixture("usb.kicad_pcb");
  const d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.boards = [b.placement];
  const nominal = proposeEnclosureLayout(d, [b]);
  d.fitAllowance = 0.1;
  const tolerant = proposeEnclosureLayout(d, [b]);
  expect(tolerant.design.openings[0]!.width - nominal.design.openings[0]!.width).toBeCloseTo(0.4);
  expect(tolerant.design.openings[0]!.height - nominal.design.openings[0]!.height).toBeCloseTo(0.4);
  expect(tolerant.design.openings[0]!.shape).toBe("rounded");
  const p = tolerant.design.boards[0]!;
  expect(
    nativeEnclosureClearanceIssues(tolerant.design, [
      { ...b, placement: p, modelBounds: { ...b.features.outline, minZ: 0, maxZ: 1.6 } },
    ]),
  ).toEqual([]);
});
test("multi-board proposal places external ports at walls, cuts openings and keeps linked posts", () => {
  const boards = Array.from({ length: 6 }, (_, i) => fixture(`board-${i}.kicad_pcb`));
  const d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.boards = boards.map((b) => b.placement);
  d.mounts = boards.map((b) => ({
    boardPath: b.placement.path,
    holeId: "h",
    x: 105,
    y: 105,
    diameter: 2.2,
    outer: 4.6,
    height: 4,
  }));
  const original = JSON.stringify(d),
    a = proposeEnclosureLayout(d, boards),
    b = proposeEnclosureLayout(d, boards);
  expect(a.design).toEqual(b.design);
  expect(JSON.stringify(d)).toBe(original);
  expect(a.openingsAdded).toBe(6);
  expect(a.externalPorts).toBe(6);
  expect(a.unresolved).toEqual([]);
  expect(a.design.openings).toHaveLength(6);
  expect(MechanicalDesignSchema.safeParse(a.design).success).toBe(true);
  for (const p of a.design.boards) {
    const m = a.design.mounts.find((m) => m.boardPath === p.path)!;
    const r = (p.rotation * Math.PI) / 180;
    expect(m.x).toBeCloseTo(p.x + 5 * Math.cos(r) - 5 * Math.sin(r));
    expect(m.y).toBeCloseTo(p.y + 5 * Math.sin(r) + 5 * Math.cos(r));
    expect(a.design.openings.find((o) => o.boardPath === p.path)?.ref).toBe("USB");
  }
});
test("explicit internal ports stay closed and native underside bounds determine height", () => {
  const b = fixture("one.kicad_pcb");
  b.modelBounds = { minX: -1, minY: 0, maxX: 40, maxY: 20, minZ: -8, maxZ: 15 };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.portAccess = [{ boardPath: b.placement.path, ref: "USB", access: "internal" }];
  const p = proposeEnclosureLayout(d, [b]);
  expect(p.design.openings).toEqual([]);
  expect(p.design.boards[0]!.z).toBeGreaterThanOrEqual(d.space.floor + 9);
  expect(p.design.space.height).toBeGreaterThan(20);
});
test("fixed imported dimensions and obstacles cannot be silently enlarged or moved", () => {
  const b = fixture("one.kicad_pcb"),
    d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.mode = "imported";
  d.source = { path: "case.stl", scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] };
  d.space.width = 10;
  d.space.depth = 10;
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
});

test("boards can be arranged below overhead obstacles while preserving vertical clearance", () => {
  const b = fixture("display-controller.kicad_pcb");
  b.features.connectors = [];
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.space = {
    x: 0,
    y: 0,
    width: 50,
    depth: 30,
    height: 25,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  };
  d.obstacles = [{ name: "Lid display", x: 0, y: 0, z: 16, width: 50, depth: 30, height: 4 }];
  const proposal = proposeEnclosureLayout(d, [b]);
  expect(proposal.design.obstacles).toEqual(d.obstacles);
  expect(proposal.design.space).toEqual(d.space);
  expect(proposal.design.boards[0]!.z + b.features.thicknessMm + d.space.clearance).toBeLessThan(
    16,
  );
  d.obstacles[0]!.z = 7;
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
});

test("obstacle height checks include underside parts and native model geometry", () => {
  const b = fixture("raised.kicad_pcb");
  b.features.connectors = [];
  b.placement = { ...b.placement, x: 5, y: 5, z: 6, locked: true };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.space = {
    x: 0,
    y: 0,
    width: 50,
    depth: 30,
    height: 25,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  };
  d.obstacles = [{ name: "Lower bracket", x: 20, y: 10, z: 2, width: 5, depth: 5, height: 1.5 }];
  expect(proposeEnclosureLayout(d, [b]).design.boards).toEqual(d.boards);
  b.features.components = [
    {
      ref: "U1",
      x: 17.5,
      y: 7.5,
      bounds: { minX: 15, minY: 5, maxX: 20, maxY: 10 },
      heightMm: 2,
      bottom: true,
    },
  ];
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
  b.features.components = [];
  b.modelBounds = { ...b.features.outline, minZ: -2, maxZ: 1.6 };
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
});

test("vertical obstacle clearance includes post bodies, screw heads and holder captures", () => {
  const b = fixture("retained.kicad_pcb");
  b.features.connectors = [];
  b.placement = { ...b.placement, x: 5, y: 5, z: 6, locked: true };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.space = {
    x: 0,
    y: 0,
    width: 50,
    depth: 30,
    height: 25,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  };
  d.obstacles = [{ name: "Lower bracket", x: 8, y: 8, z: 2, width: 4, depth: 4, height: 1 }];
  expect(proposeEnclosureLayout(d, [b]).design.boards).toEqual(d.boards);
  d.mounts = [
    { boardPath: b.placement.path, holeId: "h", x: 10, y: 10, diameter: 2.2, outer: 5, height: 4 },
  ];
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
  // A bracket beneath the middle of the PCB does not collide with its corner post.
  d.obstacles[0]!.x = 20;
  expect(proposeEnclosureLayout(d, [b]).design.boards).toEqual(d.boards);
  d.obstacles = [{ name: "Lid display", x: 0, y: 0, z: 11, width: 50, depth: 30, height: 4 }];
  expect(proposeEnclosureLayout(d, [b]).design.boards).toEqual(d.boards);
  Object.assign(d.mounts[0]!, { headDiameter: 6, headHeight: 3 });
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
  d.mounts = [];
  d.holders = [{ boardPath: b.placement.path, kind: "corner-clamps" }];
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
});
test("unlinked manual mounting points require explicit review", () => {
  const b = fixture("one.kicad_pcb"),
    d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.mounts = [{ x: 0, y: 0, diameter: 2, outer: 5, height: 4 }];
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("Link manual posts");
});
test("locks preserve the full placement and case while preferred walls constrain rotations", () => {
  const b = fixture("locked.kicad_pcb"),
    d = defaultEnclosureDesign(null);
  b.placement = { ...b.placement, x: 2, y: 2, z: 6, rotation: 0 };
  d.boards = [{ ...b.placement, locked: true }];
  d.space.width = 100;
  d.space.depth = 70;
  d.portAccess = [{ boardPath: b.placement.path, ref: "USB", access: "external", wall: "minX" }];
  const p = proposeEnclosureLayout(d, [b]);
  expect(p.design.boards[0]!).toEqual(d.boards[0]!);
  expect(p.design.space.width).toBe(100);
  expect(p.design.space.depth).toBe(70);
  expect(p.design.openings[0]!.wall).toBe("minX");
  d.portAccess[0]!.wall = "maxX";
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
});
test("cable length and slack are enforced and missing endpoints cannot silently pass", () => {
  const boards = [fixture("one.kicad_pcb"), fixture("two.kicad_pcb")],
    d = defaultEnclosureDesign(null);
  d.boards = boards.map((b) => b.placement);
  d.connections = [
    {
      id: "ribbon",
      from: { boardPath: "one.kicad_pcb", ref: "FFC" },
      to: { boardPath: "two.kicad_pcb", ref: "FFC" },
      length: 100,
      slack: 10,
    },
  ];
  const p = proposeEnclosureLayout(d, boards);
  expect(p.cables[0]!.reachable).toBe(true);
  expect(p.cables[0]!.required).toBeLessThanOrEqual(100);
  d.connections[0]!.length = 1;
  expect(() => proposeEnclosureLayout(d, boards)).toThrow("No collision-free");
  d.connections[0]!.from.ref = "missing";
  expect(() => proposeEnclosureLayout(d, boards)).toThrow("endpoint");
});
test("opening dimensions and mating reach are independent from component clearance", () => {
  const b = fixture("port.kicad_pcb"),
    d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.openingClearance = 0.3;
  d.portAccess = [
    {
      boardPath: b.placement.path,
      ref: "USB",
      access: "external",
      face: "minX",
      wall: "minY",
      aperture: { width: 6, height: 2 },
      plug: { width: 12, height: 8, depth: 20, reach: 5 },
    },
  ];
  const p = proposeEnclosureLayout(d, [b]);
  expect(p.design.openings[0]!.width).toBeCloseTo(6.6);
  expect(p.design.openings[0]!.height).toBeCloseTo(2.6);
  expect(p.design.openings[0]!.wall).toBe("minY");
  d.portAccess[0]!.plug!.reach = 0;
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("No collision-free");
});
test("assembly option reserves wider board spacing and keeps deterministic results", () => {
  const boards = [fixture("one.kicad_pcb"), fixture("two.kicad_pcb")],
    d = defaultEnclosureDesign(null);
  d.boards = boards.map((b) => b.placement);
  const compact = proposeEnclosureLayout(d, boards, "compact"),
    assembly = proposeEnclosureLayout(d, boards, "assembly"),
    ports = proposeEnclosureLayout(d, boards, "ports");
  expect(assembly.boardGap).toBeGreaterThan(compact.boardGap);
  expect(ports.goal).toBe("ports");
  expect(proposeEnclosureLayout(d, boards, "assembly").design).toEqual(assembly.design);
});
test("native model bounds reveal underside and lid clearance missed by estimates", () => {
  const b = fixture("native.kicad_pcb"),
    d = defaultEnclosureDesign(null);
  b.placement = { ...b.placement, x: 5, y: 5, z: 6 };
  d.boards = [b.placement];
  d.space = { ...d.space, width: 100, depth: 80, height: 14 };
  b.modelBounds = { minX: 0, minY: 0, maxX: 40, maxY: 20, minZ: -1, maxZ: 10 };
  expect(nativeEnclosureClearanceIssues(d, [b])[0]!.code).toBe("native-clearance");
  d.space.height = 16;
  expect(nativeEnclosureClearanceIssues(d, [b])).toEqual([]);
  b.modelBounds.minZ = -5;
  expect(nativeEnclosureClearanceIssues(d, [b])[0]!.severity).toBe("error");
});

test("automatic layout removes accidental empty height while respecting underside models and locks", () => {
  const b = fixture("raised.kicad_pcb");
  b.features.connectors = [];
  b.placement.z = 105;
  b.modelBounds = { minX: 0, minY: 0, maxX: 40, maxY: 20, minZ: -7, maxZ: 8 };
  const d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  const next = proposeEnclosureLayout(d, [b]).design;
  expect(next.boards[0]!.z).toBe(10);
  expect(next.space.height).toBeLessThan(25);
  expect(nativeEnclosureClearanceIssues(next, [{ ...b, placement: next.boards[0]! }])).toEqual([]);
  expect(d.boards[0]!.z).toBe(105);
  d.boards[0] = { ...next.boards[0]!, z: 15, locked: true };
  d.space = { ...next.space, height: 30 };
  expect(proposeEnclosureLayout(d, [b]).design.boards[0]!.z).toBe(15);
});
test("print area bounds include case walls and failure never silently ignores the limit", () => {
  const bs = Array.from({ length: 6 }, (_, i) => fixture(`print-${i}.kicad_pcb`)),
    d = defaultEnclosureDesign(null);
  d.boards = bs.map((b) => b.placement);
  d.layoutLimit = { width: 110, depth: 110 };
  const p = proposeEnclosureLayout(d, bs);
  expect(p.design.space.width + 2 * d.space.wall).toBeLessThanOrEqual(110);
  expect(p.design.space.depth + 2 * d.space.wall).toBeLessThanOrEqual(110);
  expect(p.search.orders).toBeGreaterThan(3);
  d.layoutLimit = { width: 20, depth: 20 };
  expect(() => proposeEnclosureLayout(d, bs)).toThrow(/print[- ]area/);
});
test("planned cables are checked against posts at their proposed positions", () => {
  const bs = [fixture("first.kicad_pcb"), fixture("second.kicad_pcb")],
    d = defaultEnclosureDesign(null);
  d.space.clearance = 0.2;
  d.boards = bs.map((b) => b.placement);
  d.mounts = bs.map((b) => ({
    boardPath: b.placement.path,
    holeId: "h",
    x: 105,
    y: 105,
    diameter: 2,
    outer: 4,
    height: 4,
  }));
  d.connections = [
    {
      id: "link",
      from: { boardPath: bs[0]!.placement.path, ref: "FFC" },
      to: { boardPath: bs[1]!.placement.path, ref: "FFC" },
      length: 150,
      slack: 5,
      routing: { diameter: 0.5, bendRadius: 0.5 },
    },
  ];
  const p = proposeEnclosureLayout(d, bs);
  const placed = bs.map((b) => ({
    ...b,
    placement: p.design.boards.find((x) => x.path === b.placement.path)!,
  }));
  expect(p.cables[0]!.reachable).toBe(true);
  expect(cableAssessments(p.design, placed, true)).toEqual(p.cables);
  expect(p.design.mounts.every((m) => m.x !== 105 || m.y !== 105)).toBe(true);
});
