import { expect, test } from "bun:test";
import { connectorOpening } from "@fabdesk/protocol";
import { extractBoardFeatures } from "../src/board-features";
import { checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { meshEnclosure } from "../src/enclosure";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";

const footprint = "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal";
const pcb = (bottom = false, fab = true, name = footprint) =>
  extractBoardFeatures(`
  (kicad_pcb (general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts"))
  (footprint "${name}"(layer "${bottom ? "B" : "F"}.Cu")(at 20 0)(property "Reference" "J1")
    (fp_rect(start -6 -1)(end 6 8)(layer "F.CrtYd"))
    ${fab ? '(fp_rect(start -4.47 0)(end 4.47 7.35)(layer "F.Fab"))' : ""}))`);

test("physical face sizing keeps the larger courtyard for collision checks", () => {
  const c = pcb().connectors[0]!;
  expect(c.bounds.maxX - c.bounds.minX).toBe(12);
  expect(connectorOpening(c).width).toBeCloseTo(8.94);
  expect(connectorOpening(c).height).toBe(3.31);
  expect(connectorOpening(c).source).toBe("GCT USB4105 drawing");
  expect(connectorOpening(pcb(false, false, "Connector_USB:Unknown").connectors[0]!).source).toBe(
    "Estimated footprint bounds",
  );
  expect(pcb(false, true, "Connector_USB:USB_C_Other").connectors[0]!.heightMm).toBe(3.6);
});

for (const bottom of [false, true])
  for (const rotation of [0, 90, 180, 270]) {
    test(`thin port fits exported opening, ${bottom ? "bottom" : "top"}, ${rotation} degrees`, () => {
      const features = pcb(bottom);
      const d = defaultEnclosureDesign(null);
      d.confirmed = true;
      d.space.clearance = 3;
      d.boards = [{ path: "board.kicad_pcb", x: 0, y: 0, z: 10, rotation: 0 }];
      const p = proposeEnclosureLayout(d, [{ placement: d.boards[0]!, features }]);
      // Rotate the entire solved assembly; its port dimensions must remain unchanged.
      const design = p.design;
      const first = design.boards[0]!;
      // Lock a board at each quarter-turn and recompute in a roomy fixed cavity.
      const a = (rotation * Math.PI) / 180;
      first.rotation = rotation;
      first.x = 50;
      first.y = 50;
      first.locked = true;
      design.space = { ...design.space, x: 0, y: 0, width: 120, depth: 120, height: 30 };
      // Move the rotated connector's courtyard to the corresponding wall.
      const c = features.connectors[0]!;
      const facing = (["minY", "maxX", "maxY", "minX"] as const)[rotation / 90]!;
      const rotated = [
        [c.bounds.minX, c.bounds.minY],
        [c.bounds.maxX, c.bounds.minY],
        [c.bounds.maxX, c.bounds.maxY],
        [c.bounds.minX, c.bounds.maxY],
      ].map(([x, y]) => ({
        x: x! * Math.cos(a) - y! * Math.sin(a),
        y: x! * Math.sin(a) + y! * Math.cos(a),
      }));
      if (facing === "minX") first.x = 3 - Math.min(...rotated.map((p) => p.x));
      if (facing === "maxX") first.x = 117 - Math.max(...rotated.map((p) => p.x));
      if (facing === "minY") first.y = 3 - Math.min(...rotated.map((p) => p.y));
      if (facing === "maxY") first.y = 117 - Math.max(...rotated.map((p) => p.y));
      const proposed = proposeEnclosureLayout(design, [{ placement: first, features }]);
      const opening = proposed.design.openings[0]!;
      expect(opening.width).toBeCloseTo(9.74);
      expect(opening.height).toBeCloseTo(4.11);
      const boards = proposed.design.boards.map((placement) => ({ placement, features }));
      expect(
        checkMechanicalFit(proposed.design, boards).issues.filter(
          (i) => i.code === "connector-opening",
        ),
      ).toEqual([]);
      // An opening shortened vertically cannot pass on width alone.
      const small = { ...proposed.design, openings: [{ ...opening, height: 2 }] };
      expect(
        checkMechanicalFit(small, boards).issues.some((i) => i.code === "connector-opening"),
      ).toBe(true);
      const mesh = meshEnclosure(enclosureFromDesign(proposed.design, boards));
      const surface = new ShellSurface(readStlTriangles(new TextEncoder().encode(mesh.baseStl)));
      const vertical = facing === "minX" || facing === "maxX";
      const wall = facing === "minX" || facing === "minY" ? 0 : 120;
      const probe = {
        name: "port",
        x: vertical ? wall - 3 : opening.offset - 0.05,
        y: vertical ? opening.offset - 0.05 : wall - 3,
        z: opening.z + opening.height / 2,
        width: vertical ? 6 : 0.1,
        depth: vertical ? 0.1 : 6,
        height: 0.1,
      };
      expect(surface.intersects(probe)).toBe(false);
      expect(surface.intersects({ ...probe, z: opening.z + opening.height + 0.2 })).toBe(true);
    });
  }

test("custom opening and explicit zero tolerance take precedence", () => {
  const features = pcb();
  const d = defaultEnclosureDesign(null);
  const placement = { path: "board.kicad_pcb", x: 0, y: 0, z: 6, rotation: 0 };
  d.boards = [placement];
  d.portAccess = [
    { boardPath: placement.path, ref: "J1", access: "external", aperture: { width: 7, height: 2 } },
  ];
  d.openingClearance = 0;
  const result = proposeEnclosureLayout(d, [{ placement, features }]);
  expect(result.design.openings[0]!.width).toBe(7);
  expect(result.design.openings[0]!.height).toBe(2);
});
