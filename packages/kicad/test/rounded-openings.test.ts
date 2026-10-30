import { expect, test } from "bun:test";
import { MechanicalDesignSchema, openingContains, openingContour } from "@fabdesk/protocol";
import { profileWall, profileTriangles, type Triangle } from "../src/enclosure-profile";
import { meshEnclosure, writeBoxesStep } from "../src/enclosure";
import { extractBoardFeatures } from "../src/board-features";
import { enclosureFromDesign, checkMechanicalFit } from "../src/mechanical-fit";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";

function closed(tris: Triangle[]) {
  const edges = new Map<string, { count: number; balance: number }>();
  const key = (p: Triangle[0]) => [p.x, p.y, p.z].map((n) => n.toFixed(8)).join(",");
  let volume = 0;
  for (const [a, b, c] of tris) {
    volume +=
      (a.x * (b.y * c.z - b.z * c.y) +
        a.y * (b.z * c.x - b.x * c.z) +
        a.z * (b.x * c.y - b.y * c.x)) /
      6;
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const x = key(p!),
        y = key(q!),
        k = x < y ? `${x}|${y}` : `${y}|${x}`;
      const prev = edges.get(k) ?? { count: 0, balance: 0 };
      prev.count++;
      prev.balance += x < y ? 1 : -1;
      edges.set(k, prev);
    }
  }
  expect([...edges.values()].filter((e) => e.count !== 2 || e.balance !== 0)).toEqual([]);
  expect(volume).toBeGreaterThan(0);
}

test("rounded contours reject a rectangle with matching outer dimensions and preserve defaults", () => {
  expect(
    openingContains({ width: 10, height: 4, shape: "rounded" }, { width: 10, height: 4 }),
  ).toBe(false);
  expect(
    openingContains(
      { width: 10, height: 4, shape: "rounded" },
      { width: 10, height: 4, shape: "rounded" },
    ),
  ).toBe(true);
  expect(
    openingContains(
      { width: 10, height: 4, shape: "rounded" },
      { width: 10, height: 4, shape: "rounded" },
      0.2,
    ),
  ).toBe(false);
  expect(openingContour(10, 4)).toHaveLength(4);
  expect(openingContour(10, 4, "rounded").length).toBeGreaterThan(40);
  const design = defaultEnclosureDesign(null);
  design.openings = [{ name: "old", wall: "minX", offset: 10, z: 6, width: 10, height: 4 }];
  expect(MechanicalDesignSchema.parse(design).openings[0]!.shape).toBeUndefined();
});

for (const rotation of [0, 90, 180, 270])
  test(`rounded USB-C opening keeps wall corners in STL, rotation ${rotation}`, () => {
    const features = extractBoardFeatures(
      '(kicad_pcb(general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts"))(footprint "Connector_USB:USB_C"(layer "F.Cu")(at 0 10)(property "Reference" "J1")(fp_rect(start -1 -4)(end 5 4)(layer "F.CrtYd"))))',
    );
    const d = defaultEnclosureDesign(null);
    d.confirmed = true;
    const position = [
      { x: 2, y: 30 },
      { x: 60, y: 2 },
      { x: 98, y: 60 },
      { x: 30, y: 98 },
    ][rotation / 90]!;
    d.space = { ...d.space, width: 100, depth: 100, height: 20 };
    d.boards = [{ path: "board.kicad_pcb", ...position, z: 6, rotation, locked: true }];
    const proposed = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }]);
    const p = proposed.design,
      o = p.openings[0]!,
      boards = p.boards.map((placement) => ({ placement, features }));
    expect(o.shape).toBe("rounded");
    expect(checkMechanicalFit(p, boards).issues.some((i) => i.code === "connector-opening")).toBe(
      false,
    );
    const spec = enclosureFromDesign(p, boards),
      mesh = meshEnclosure(spec);
    for (const solid of spec.solids.filter((s) => s.kind === "profile"))
      closed(profileTriangles(solid));
    const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(mesh.baseStl)));
    const vertical = o.wall.endsWith("X"),
      wall = o.wall.startsWith("min") ? 0 : 100;
    const probe = (u: number, v: number) => ({
      name: "probe",
      x: vertical ? wall - 3 : o.offset + u - 0.02,
      y: vertical ? o.offset + u - 0.02 : wall - 3,
      z: o.z + o.height / 2 + v - 0.02,
      width: vertical ? 6 : 0.04,
      depth: vertical ? 0.04 : 6,
      height: 0.04,
    });
    expect(surface.intersects(probe(0, 0))).toBe(false);
    expect(surface.intersects(probe(o.width / 2 - 0.15, 0))).toBe(false);
    expect(surface.intersects(probe(o.width / 2 - 0.15, o.height / 2 - 0.15))).toBe(true);
    // Same-sized rectangular requirements cannot silently pass a rounded hole.
    p.portAccess = [
      {
        boardPath: p.boards[0]!.path,
        ref: "J1",
        access: "external",
        aperture: { width: 8, height: 3.6, shape: "rectangle" },
      },
    ];
    expect(checkMechanicalFit(p, boards).issues.some((i) => i.code === "connector-opening")).toBe(
      true,
    );
  });

test("overlapping rounded openings and a top-edge notch produce closed profiles and shared STEP edges", () => {
  const wall = { min: { x: 0, y: -2, z: 0 }, max: { x: 30, y: 0, z: 15 } };
  const cuts = [10, 16].map((x) => ({
    ref: String(x),
    edge: "minY" as const,
    shape: "rounded" as const,
    center: { x, y: 0, z: 7 },
    widthMm: 10,
    heightMm: 4,
    connector: { x, y: 0, widthMm: 10, heightMm: 4 },
  }));
  const solids = profileWall(
    "Curve",
    "minY",
    wall,
    [{ min: { x: 24, y: -2, z: 12 }, max: { x: 27, y: 0, z: 16 } }],
    cuts,
  );
  expect(solids).toHaveLength(1);
  const triangles = profileTriangles(solids[0]!);
  closed(triangles);
  const step = writeBoxesStep([], [], [{ name: "Curve", triangles }]);
  expect(step.match(/ADVANCED_FACE\(/g)?.length).toBe(triangles.length);
  const used = new Map<string, number>();
  for (const m of step.matchAll(/ORIENTED_EDGE\('',\*,\*,#(\d+),\.[TF]\.\)/g))
    used.set(m[1]!, 1 + (used.get(m[1]!) ?? 0));
  expect([...used.values()].every((n) => n === 2)).toBe(true);
  expect(step.match(/MANIFOLD_SOLID_BREP/g)?.length).toBe(1);
});
