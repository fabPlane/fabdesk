import { expect, test } from "bun:test";
import { extractBoardFeatures } from "../src/board-features";
import { checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { meshEnclosure } from "../src/enclosure";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";

test("automatic case fitting reserves board screw heads and blind screw length", () => {
  const features = extractBoardFeatures(`(kicad_pcb(general(thickness 1.6))
    (gr_rect(start 0 0)(end 30 20)(layer "Edge.Cuts"))
    (footprint "MountingHole:MountingHole_3.2mm_M3"(layer "F.Cu")(at 3 3)(property "Reference" "H1")
      (pad "" np_thru_hole circle(at 0 0)(size 3.2 3.2)(drill 3.2)(layers "*.Cu" "*.Mask"))))`);
  const d = defaultEnclosureDesign(features);
  d.confirmed = true;
  d.fitAllowance = 0.1;
  d.mounts[0] = {
    ...d.mounts[0]!,
    headDiameter: 12,
    headHeight: 5,
    screwDiameter: 3,
    screwLength: 10,
  };
  const original = structuredClone(d);
  const p = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }]);
  const report = checkMechanicalFit(p.design, [{ placement: p.design.boards[0]!, features }]);
  expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
  const m = p.design.mounts[0]!;
  expect(m.height + features.thicknessMm).toBeGreaterThanOrEqual(
    m.screwLength! + 2 * d.fitAllowance,
  );
  expect(p.design.space.floor + p.design.space.height).toBeGreaterThanOrEqual(
    p.design.boards[0]!.z + features.thicknessMm + m.headHeight! + d.space.clearance,
  );
  expect(m.screwLength).toBe(10);
  expect(m.headDiameter).toBe(12);
  expect(d).toEqual(original);
  const mesh = meshEnclosure(
    enclosureFromDesign(p.design, [{ placement: p.design.boards[0]!, features }]),
  );
  const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(mesh.baseStl)));
  const probe = (x: number, z: number) => ({
    name: "Post section",
    x,
    y: m.y - 0.025,
    z,
    width: 0.05,
    depth: 0.05,
    height: 0.05,
  });
  expect(
    surface.intersects(probe(m.x + m.outer / 2 - 0.025, p.design.space.floor + m.height / 2)),
  ).toBe(true);
  expect(surface.intersects(probe(m.x, p.design.space.floor + m.height / 2))).toBe(false);
  expect(surface.intersects(probe(m.x, p.design.space.floor - 0.025))).toBe(true);

  d.boards[0]!.locked = true;
  const locked = structuredClone(d);
  expect(() => proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }])).toThrow(
    "Unlock and raise the board",
  );
  expect(d).toEqual(locked);
  d.boards[0]!.locked = false;
  d.mounts[0]!.screwLength = 1;
  expect(() => proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }])).toThrow(
    "must reach below the PCB",
  );
});

test("automatic sizing retains connector and tall-part envelopes in older board summaries", () => {
  const features = extractBoardFeatures(`(kicad_pcb(general(thickness 1.6))
    (gr_rect(start 0 0)(end 30 20)(layer "Edge.Cuts"))
    (footprint "Connector_USB:USB_C"(layer "F.Cu")(at 15 0)(property "Reference" "J1")(property "Height" "5")
      (fp_rect(start -4 -3)(end 4 5)(layer "F.CrtYd")))
    (footprint "Capacitor_THT:CP_Radial"(layer "F.Cu")(at 30 10)(property "Reference" "C1")(property "Height" "28")
      (fp_rect(start -5 -5)(end 5 5)(layer "F.CrtYd"))))`);
  // Older summaries carry these same bodies in connectors/tallParts instead of components.
  const { components: _components, ...legacy } = features;
  const d = defaultEnclosureDesign(features);
  d.confirmed = true;
  const full = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }]);
  const older = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features: legacy }]);
  expect(
    checkMechanicalFit(older.design, [
      { placement: older.design.boards[0]!, features },
    ]).issues.filter((i) => i.severity === "error"),
  ).toEqual([]);
  expect(older.design).toEqual(full.design);
  const initial = { ...defaultEnclosureDesign(legacy), confirmed: true };
  expect(
    checkMechanicalFit(initial, [{ placement: initial.boards[0]!, features }]).issues.filter(
      (i) => i.code === "outside-space",
    ),
  ).toEqual([]);
  expect(initial.space).toEqual(defaultEnclosureDesign(features).space);
});

test("automatic case height leaves wall material around tall custom ports on either PCB side", () => {
  for (const bottom of [false, true]) {
    const features = extractBoardFeatures(`(kicad_pcb(general(thickness 1.6))
      (gr_rect(start 0 0)(end 30 20)(layer "Edge.Cuts"))
      (footprint "Connector_USB:USB_C"(layer "${bottom ? "B" : "F"}.Cu")(at 15 0)(property "Reference" "J1")(property "Height" "3")
        (fp_rect(start -4 0)(end 4 5)(layer "${bottom ? "B" : "F"}.CrtYd"))
        (fp_rect(start -4 0)(end 4 5)(layer "${bottom ? "B" : "F"}.Fab"))))`);
    const d = defaultEnclosureDesign(features);
    d.confirmed = true;
    d.fitAllowance = 0.1;
    d.portAccess = [
      {
        boardPath: d.boards[0]!.path,
        ref: "J1",
        access: "external",
        aperture: { width: 8, height: 12 },
      },
    ];
    const original = structuredClone(d);
    const p = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }]);
    const placed = [{ placement: p.design.boards[0]!, features }];
    expect(
      checkMechanicalFit(p.design, placed).issues.filter((i) => i.severity === "error"),
    ).toEqual([]);
    const o = p.design.openings[0]!;
    expect(o.z - p.design.space.floor).toBeGreaterThanOrEqual(p.design.space.wall - 1e-5);
    expect(p.design.space.floor + p.design.space.height - o.z - o.height).toBeGreaterThanOrEqual(
      p.design.space.wall - 1e-5,
    );
    expect(o.height).toBeCloseTo(13.2);
    expect(d).toEqual(original);
    const mesh = meshEnclosure(enclosureFromDesign(p.design, placed));
    const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(mesh.baseStl)));
    const vertical = o.wall.endsWith("X");
    const wall =
      o.wall === "minX"
        ? p.design.space.x
        : o.wall === "maxX"
          ? p.design.space.x + p.design.space.width
          : o.wall === "minY"
            ? p.design.space.y
            : p.design.space.y + p.design.space.depth;
    const probe = (z: number) => ({
      name: "Opening slice",
      x: vertical ? wall - 3 : o.offset - 0.05,
      y: vertical ? o.offset - 0.05 : wall - 3,
      z,
      width: vertical ? 6 : 0.1,
      depth: vertical ? 0.1 : 6,
      height: 0.1,
    });
    expect(surface.intersects(probe(o.z + o.height / 2))).toBe(false);
    expect(surface.intersects(probe(o.z - 0.2))).toBe(true);
    expect(surface.intersects(probe(o.z + o.height + 0.1))).toBe(true);
    // The same settings must not silently enlarge a locked case.
    d.boards[0]!.locked = true;
    d.boards[0]!.z = 10;
    d.space.height = 14;
    expect(() => proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }])).toThrow(
      "No collision-free layout",
    );
  }
});

test("wide off-center openings expand the needed wall span without treating them as PCB bodies", () => {
  const features = extractBoardFeatures(`(kicad_pcb(general(thickness 1.6))
    (gr_rect(start 0 0)(end 30 20)(layer "Edge.Cuts"))
    (footprint "Connector_USB:USB_C"(layer "F.Cu")(at 2 0)(property "Reference" "J1")(property "Height" "3")
      (fp_rect(start -1 0)(end 1 3)(layer "F.CrtYd"))(fp_rect(start -1 0)(end 1 3)(layer "F.Fab"))))`);
  const d = defaultEnclosureDesign(features);
  d.confirmed = true;
  d.fitAllowance = 0.1;
  d.portAccess = [
    {
      boardPath: d.boards[0]!.path,
      ref: "J1",
      access: "external",
      face: "minY",
      aperture: { width: 40, height: 3 },
    },
  ];
  const p = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }]);
  expect(p.unresolved).toEqual([]);
  const report = checkMechanicalFit(p.design, [{ placement: p.design.boards[0]!, features }]);
  expect(report.issues.filter((i) => i.severity === "error" || i.code === "opening-web")).toEqual(
    [],
  );
  const o = p.design.openings[0]!;
  const min = o.wall.endsWith("X") ? p.design.space.y : p.design.space.x;
  const span = o.wall.endsWith("X") ? p.design.space.depth : p.design.space.width;
  expect(o.offset - o.width / 2 - min).toBeGreaterThanOrEqual(p.design.space.wall - 1e-5);
  expect(min + span - o.offset - o.width / 2).toBeGreaterThanOrEqual(p.design.space.wall - 1e-5);
  for (const wall of ["minX", "maxX", "minY", "maxY"] as const) {
    const turned = proposeEnclosureLayout({ ...d, portAccess: [{ ...d.portAccess[0]!, wall }] }, [
      { placement: d.boards[0]!, features },
    ]);
    expect(turned.design.openings[0]!.wall).toBe(wall);
    expect(
      checkMechanicalFit(turned.design, [
        { placement: turned.design.boards[0]!, features },
      ]).issues.filter((i) => i.severity === "error" || i.code === "opening-web"),
    ).toEqual([]);
  }
  const auxiliary = extractBoardFeatures(
    '(kicad_pcb(general(thickness 1.6))(gr_rect(start 0 0)(end 8 8)(layer "Edge.Cuts")))',
  );
  const extra = { path: "auxiliary.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 };
  const assembly = proposeEnclosureLayout({ ...d, boards: [...d.boards, extra] }, [
    { placement: d.boards[0]!, features },
    { placement: extra, features: auxiliary },
  ]);
  expect(assembly.design.space.width * assembly.design.space.depth).toBeLessThanOrEqual(52 * 23);
  expect(
    checkMechanicalFit(
      assembly.design,
      assembly.design.boards.map((placement) => ({
        placement,
        features: placement.path === extra.path ? auxiliary : features,
      })),
    ).issues.filter((i) => i.severity === "error"),
  ).toEqual([]);
  d.boards[0]!.locked = true;
  const original = structuredClone(d);
  expect(() => proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }])).toThrow(
    "No collision-free layout",
  );
  expect(d).toEqual(original);
});
test("port-aware placements produce real open wall cutouts in exported STL", () => {
  const features =
    extractBoardFeatures(`(kicad_pcb(general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts"))
  (footprint "Connector_USB:USB_C"(layer "F.Cu")(at 0 10)(property "Reference" "J1")(fp_rect(start -1 -4)(end 5 4)(layer "F.CrtYd"))))`);
  const boards = Array.from({ length: 4 }, (_, i) => ({
    placement: { path: `board${i}.kicad_pcb`, x: 0, y: 0, z: 6, rotation: 0 },
    features,
  }));
  const design = defaultEnclosureDesign(null);
  design.confirmed = true;
  design.boards = boards.map((b) => b.placement);
  const p = proposeEnclosureLayout(design, boards);
  const placed = p.design.boards.map((placement) => ({ placement, features }));
  expect(p.openingsAdded).toBe(4);
  const report = checkMechanicalFit(p.design, placed);
  expect(
    report.issues.filter((i) => i.severity === "error" || i.code === "connector-opening"),
  ).toEqual([]);
  const wrongWall = {
    ...p.design,
    openings: p.design.openings.map((o) => ({
      ...o,
      wall: (o.wall === "minX" ? "maxX" : "minX") as "minX" | "maxX",
    })),
  };
  expect(
    checkMechanicalFit(wrongWall, placed).issues.some((i) => i.code === "connector-opening"),
  ).toBe(true);
  const mesh = meshEnclosure(enclosureFromDesign(p.design, placed));
  const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(mesh.baseStl)));
  const s = p.design.space;
  for (const o of p.design.openings) {
    const vertical = o.wall === "minX" || o.wall === "maxX",
      wall =
        o.wall === "minX"
          ? s.x
          : o.wall === "maxX"
            ? s.x + s.width
            : o.wall === "minY"
              ? s.y
              : s.y + s.depth;
    const probe = {
      name: "port",
      x: vertical ? wall - s.wall - 1 : o.offset - 0.05,
      y: vertical ? o.offset - 0.05 : wall - s.wall - 1,
      z: o.z + o.height / 2 - 0.05,
      width: vertical ? s.wall * 2 + 2 : 0.1,
      depth: vertical ? 0.1 : s.wall * 2 + 2,
      height: 0.1,
    };
    expect(surface.intersects(probe)).toBe(false);
    const solid = { ...probe, z: s.floor + 0.1 };
    expect(surface.intersects(solid)).toBe(true);
  }
  // A moved board no longer passes the same port-access check.
  const moved = {
    ...p.design,
    boards: p.design.boards.map((b) => ({ ...b, x: b.x + 15, y: b.y + 15 })),
  };
  expect(
    checkMechanicalFit(
      moved,
      moved.boards.map((placement) => ({ placement, features })),
    ).issues.some((i) => i.code === "connector-opening"),
  ).toBe(true);
});
