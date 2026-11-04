import { expect, test } from "bun:test";
import { connectorOpening } from "@fabdesk/protocol";
import { extractBoardFeatures, estimatePartHeightMm } from "../src/board-features";
import { checkMechanicalFit, enclosureFromDesign } from "../src/mechanical-fit";
import { meshEnclosure } from "../src/enclosure";
import { ShellSurface, readStlTriangles } from "../src/shell-fit";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { proposeEnclosureLayout } from "../../client-core/src/enclosure-layout";

const footprint = "Connector_USB:USB_C_Receptacle_GCT_USB4105-xx-A_16P_TopMnt_Horizontal";
const microSd = "Connector_Card:microSD_HC_Hirose_DM3D-SF";
const microUsb = "Connector_USB:USB_Micro-B_Molex-105017-0001";
test("explicit PCB height supports thin unknown connectors and rejects ambiguous units", () => {
  for (const [height, expected] of [
    ["1.25 mm", 1.25],
    ["0.8", 0.8],
    ["2 in", 5],
    ["-1", 5],
    ["0", 5],
    ["999", 5],
  ] as const) {
    const f = extractBoardFeatures(
      `(kicad_pcb (gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts"))(footprint "Connector:Unknown" (layer "F.Cu")(at 20 0)(property "Reference" "J1")(property "Height" "${height}")(fp_rect(start -3 -1)(end 3 3)(layer "F.Fab"))(fp_rect(start -4 -2)(end 4 4)(layer "F.CrtYd"))))`,
    );
    expect(f.connectors[0]!.heightMm).toBe(expected);
    if (expected !== 5) expect(f.connectors[0]!.face?.source).toBe("PCB Height property");
    else expect(f.warnings.some((w) => w.includes("Height property"))).toBe(true);
  }
});
const pcb = (bottom = false, fab = true, name = footprint) =>
  extractBoardFeatures(`
  (kicad_pcb (general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts"))
  (footprint "${name}"(layer "${bottom ? "B" : "F"}.Cu")(at 20 0)(property "Reference" "J1")
    (fp_rect(start -6 -1)(end 6 8)(layer "F.CrtYd"))
    ${fab ? '(fp_rect(start -4.47 0)(end 4.47 7.35)(layer "F.Fab"))' : ""}))`);

test("exact Micro-USB profile replaces generic USB height without guessing for other parts", () => {
  const f = pcb(false, true, microUsb);
  expect(f.connectors[0]!.heightMm).toBe(2.94);
  expect(connectorOpening(f.connectors[0]!)).toMatchObject({
    height: 2.94,
    source: "Molex 105017-0001 catalog maximum",
  });
  expect(estimatePartHeightMm(`${microUsb}_Modified`)).toBe(7);
  expect(estimatePartHeightMm("Connector_USB:USB_A")).toBe(7);
  for (const bottom of [true, false]) {
    const b = pcb(bottom, true, microUsb);
    const d = defaultEnclosureDesign(b);
    const opening = d.openings[0]!;
    expect(opening.height).toBeCloseTo(3.74);
    expect(opening.width).toBeCloseTo(9.74);
    expect(opening.z).toBeCloseTo(d.boards[0]!.z + (bottom ? -2.94 : b.thicknessMm) - 0.4);
  }
});

test("initial case openings use the same physical face and padding as arranged openings", () => {
  for (const name of [footprint, microSd, microUsb]) {
    const features = pcb(false, true, name);
    const initial = defaultEnclosureDesign(features);
    const arranged = proposeEnclosureLayout(initial, [
      { placement: initial.boards[0]!, features },
    ]).design;
    for (const key of ["width", "height", "shape"] as const)
      expect(initial.openings[0]![key]).toEqual(arranged.openings[0]![key]);
  }
});

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

test("microSD uses its documented low body height, without changing unrelated card connectors", () => {
  const features = pcb(false, true, microSd);
  const c = features.connectors[0]!;
  expect(c.heightMm).toBe(1.55);
  expect(features.components?.find((p) => p.ref === c.ref)?.heightMm).toBe(1.55);
  expect(connectorOpening(c)).toMatchObject({
    height: 1.55,
    centerZ: 0.775,
    shape: "rectangle",
    source: "Hirose DM3D-SF drawing",
  });
  expect(estimatePartHeightMm(microSd)).toBe(1.55);
  expect(pcb(false, false, microSd).connectors[0]!.heightMm).toBe(1.55);
  for (const name of [
    "Connector_Card:microSD_Unknown",
    `${microSd}_Modified`,
    "Connector_Card:DM3AT-SF",
  ])
    expect(pcb(false, true, name).connectors[0]!.heightMm).toBe(5);
  expect(connectorOpening(c, c.edge, { width: 11, height: 1 })).toMatchObject({
    width: 11,
    height: 1,
    centerZ: 0.775,
    source: "Custom dimensions",
  });
});

for (const part of [
  { name: footprint, height: 4.11 },
  { name: microSd, height: 2.35 },
  { name: microUsb, height: 3.74 },
])
  for (const bottom of [false, true])
    for (const rotation of [0, 90, 180, 270]) {
      test(`${part.name} fits exported opening, ${bottom ? "bottom" : "top"}, ${rotation} degrees`, () => {
        const features = pcb(bottom, true, part.name);
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
        expect(opening.height).toBeCloseTo(part.height);
        const mountingZ = bottom ? first.z : first.z + features.thicknessMm;
        const portHeight = features.connectors[0]!.heightMm;
        expect(opening.z).toBeCloseTo(mountingZ - (bottom ? portHeight : 0) - 0.4);
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
