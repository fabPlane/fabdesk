import { expect, test } from "bun:test";
import { extractBoardFeatures } from "../src/board-features";
import { checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { meshEnclosure } from "../src/enclosure";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";
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
