import { test, expect } from "bun:test";
import { joinedEnclosure, solidKernel, inspectSolid } from "../src/enclosure-solid";
import { generateEnclosure } from "../src/enclosure";
import { extractBoardFeatures } from "../src/board-features";
import { checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { enclosureHardware } from "../src/enclosure-hardware";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";

const features = () =>
  extractBoardFeatures(
    '(kicad_pcb (general (thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts")))',
  );

test("offset rectangular ports keep the wall above and between openings intact", async () => {
  const d = defaultEnclosureDesign(null);
  d.space = {
    x: 0,
    y: 0,
    width: 241,
    depth: 116,
    height: 20,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  };
  // Two openings with nearly aligned edges, at different heights. The wall
  // between them is intentional; cutting the second must not discard it.
  d.openings = [
    { name: "Lower port", wall: "minY", offset: 110.58, z: 7.2, width: 8.3, height: 3 },
    { name: "Upper port", wall: "minY", offset: 110.6, z: 12, width: 8.3, height: 3 },
  ];
  const m = await joinedEnclosure(enclosureFromDesign(d, []));
  const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(m.baseStl)));
  const probe = (x: number, z: number) =>
    surface.intersects({
      name: "wall sample",
      x,
      y: -3,
      z,
      width: 0.002,
      depth: 4,
      height: 0.002,
    });
  expect(probe(110.58, 8)).toBe(false);
  expect(probe(110.6, 13)).toBe(false);
  expect(probe(114.74, 10.8)).toBe(true);
  expect(probe(114.74, 18)).toBe(true);
  expect(probe(106.44, 18)).toBe(true);
  expect(m.validation.base.components).toBe(1);
});
function fixture() {
  const d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.space = {
    x: 0,
    y: 0,
    width: 60,
    depth: 40,
    height: 18,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  };
  d.boards = [{ path: "board.kicad_pcb", x: 10, y: 10, z: 5, rotation: 0 }];
  d.closure = {
    kind: "screws",
    screwDiameter: 3,
    screwLength: 8,
    pilotDiameter: 2.5,
    clearanceDiameter: 3.4,
    bossDiameter: 8,
  };
  d.holders = [{ boardPath: d.boards[0]!.path, kind: "corner-clamps" }];
  return { d, boards: [{ placement: d.boards[0]!, features: features() }] };
}
test("boolean export produces one closed solid per part, with joined floor, walls and lip", async () => {
  const spec = generateEnclosure(features());
  const m = await joinedEnclosure(spec);
  expect(m.validation.base.components).toBe(1);
  expect(m.validation.lid.components).toBe(1);
  expect(m.validation.base.volumeMm3).toBeGreaterThan(0);
  expect(m.step.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
  const vertices = readStlTriangles(new TextEncoder().encode(m.baseStl));
  const edges = new Map<string, number>();
  for (let i = 0; i < vertices.length; i += 9)
    for (let j = 0; j < 3; j++) {
      const a = Array.from(vertices.slice(i + j * 3, i + j * 3 + 3)).join(","),
        b = Array.from(vertices.slice(i + ((j + 1) % 3) * 3, i + ((j + 1) % 3) * 3 + 3)).join(",");
      const key = [a, b].sort().join("|");
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  expect([...edges.values()].every((n) => n === 2)).toBe(true);
});
test("disconnected hardware is rejected rather than exported as a ready case", async () => {
  const spec = generateEnclosure(features());
  spec.solids.push({
    name: "floating",
    kind: "box",
    role: "standoff",
    min: { x: 100, y: 100, z: 30 },
    max: { x: 102, y: 102, z: 32 },
  });
  await expect(joinedEnclosure(spec)).rejects.toThrow("disconnected");
});
test("open triangle meshes are rejected by solid validation", async () => {
  const k = await solidKernel();
  expect(
    () =>
      new k.Manifold(
        new k.Mesh({
          numProp: 3,
          vertProperties: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          triVerts: new Uint32Array([0, 1, 2]),
        }),
      ),
  ).toThrow();
});
test("four screw lugs and corner holders join both parts and leave screw bores open", async () => {
  const { d, boards } = fixture();
  expect(checkMechanicalFit(d, boards).issues.filter((i) => i.severity === "error")).toEqual([]);
  const m = await joinedEnclosure(enclosureFromDesign(d, boards));
  expect(m.validation.base.components).toBe(1);
  expect(m.validation.lid.components).toBe(1);
  const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(m.baseStl)));
  expect(
    surface.intersects({ name: "bore", x: -5.3, y: 4.9, z: 1, width: 0.2, depth: 0.2, height: 18 }),
  ).toBe(false);
  expect(
    surface.intersects({
      name: "post surface",
      x: -9.3,
      y: 4.9,
      z: 1,
      width: 0.2,
      depth: 0.2,
      height: 18,
    }),
  ).toBe(true);
});
test("holder corners cannot hide components, other boards or fixed obstacles", () => {
  const { d, boards } = fixture();
  d.obstacles = [{ name: "wire", x: 9, y: 9, z: 3, width: 2, depth: 2, height: 3 }];
  expect(
    checkMechanicalFit(d, boards).issues.some(
      (i) => i.code === "holder-collision" && i.severity === "error",
    ),
  ).toBe(true);
  boards[0]!.features.components = [
    {
      ref: "U1",
      footprint: "QFN",
      x: 1,
      y: 1,
      heightMm: 2,
      bottom: false,
      bounds: { minX: 0, minY: 0, maxX: 3, maxY: 3 },
    },
  ];
  expect(enclosureHardware(d, boards).issues.some((i) => i.message.includes("U1"))).toBe(true);
});
test("retention requires a suitable outline, screwed lid and screw engagement", () => {
  const { d, boards } = fixture();
  d.closure!.screwLength = 3;
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "closure-length")).toBe(true);
  d.closure!.kind = "lift-off";
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-closure")).toBe(true);
  boards[0]!.features.warnings = ["Non-rectangular Edge.Cuts contour"];
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "holder-outline")).toBe(true);
});
test("lid lugs try the other walls, then block export if neither pair is clear", () => {
  const { d, boards } = fixture();
  d.openings = [{ name: "USB", wall: "minX", offset: 5, z: 5, width: 8, height: 4 }];
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "hardware-access")).toBe(
    false,
  );
  d.openings[0]!.width = 40;
  d.openings[0]!.offset = 20;
  d.openings.push({ name: "Front port", wall: "minY", offset: 30, z: 5, width: 60, height: 4 });
  expect(checkMechanicalFit(d, boards).issues.some((i) => i.code === "hardware-access")).toBe(true);
});

test("print lid sits on its outside face at Z zero and preserves its solid volume", async () => {
  const { d, boards } = fixture(),
    m = await joinedEnclosure(enclosureFromDesign(d, boards));
  const { auditStl } = await import("../src/enclosure-solid");
  const bytes = new TextEncoder().encode(m.lidPrintStl),
    triangles = readStlTriangles(bytes);
  const z = Array.from(triangles).filter((_, i) => i % 3 === 2);
  expect(Math.min(...z)).toBeCloseTo(0, 5);
  expect((await auditStl(bytes)).volumeMm3).toBeCloseTo(m.validation.lid.volumeMm3, 2);
});

test("automatic layout reserves room for no-hole holders", () => {
  const { d, boards } = fixture();
  d.space.clearance = 1;
  const proposed = proposeEnclosureLayout(d, boards).design;
  const result = enclosureHardware(proposed, [{ ...boards[0]!, placement: proposed.boards[0]! }]);
  expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
});

test("corner holders cannot fill an existing mounting post bore", () => {
  const { d, boards } = fixture();
  d.mounts = [{ x: 11, y: 11, diameter: 2, outer: 5, height: 3 }];
  expect(
    enclosureHardware(d, boards).issues.some(
      (i) => i.code === "holder-collision" && i.message.includes("Mounting post"),
    ),
  ).toBe(true);
});

test("print samples preserve rounded port size and offer three real screw pilots", async () => {
  const { enclosureFitSamples, auditStl } = await import("../src/enclosure-solid");
  const { d } = fixture();
  d.openings = [
    { name: "USB-C", wall: "minY", offset: 20, z: 6, width: 10, height: 4, shape: "rounded" },
  ];
  const files = await enclosureFitSamples(d);
  for (const [path, text] of Object.entries(files))
    if (path.endsWith(".stl"))
      expect((await auditStl(new TextEncoder().encode(text))).components).toBe(1);
  expect(files["fit-samples/README.txt"]).toContain("2.40, 2.50, 2.60");
  const surface = new ShellSurface(
    readStlTriangles(new TextEncoder().encode(files["fit-samples/port-01.stl"]!)),
  );
  expect(
    surface.intersects({
      name: "hole",
      x: 7.95,
      y: 4.95,
      z: -1,
      width: 0.1,
      depth: 0.1,
      height: 4,
    }),
  ).toBe(false);
  expect(
    surface.intersects({
      name: "corner",
      x: 3.05,
      y: 3.05,
      z: -1,
      width: 0.1,
      depth: 0.1,
      height: 4,
    }),
  ).toBe(true);
});
