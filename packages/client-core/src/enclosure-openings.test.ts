import { expect, test } from "bun:test";
import { MechanicalDesignSchema } from "@fabdesk/protocol";
import { defaultEnclosureDesign } from "./enclosure-design";
import { refreshEnclosureOpenings } from "./enclosure-openings";
import { proposeEnclosureLayout, type LayoutBoard } from "./enclosure-layout";
import { prepareEnclosurePreview, resizeEnclosureToFit } from "./enclosure-setup";

function fixture(bottom = false) {
  const features: LayoutBoard["features"] = {
    pcbRevision: "test",
    thicknessMm: 1.6,
    outline: { minX: 0, minY: 0, maxX: 40, maxY: 20, widthMm: 40, heightMm: 20 },
    holes: [],
    components: [
      {
        ref: "J1",
        x: 20,
        y: 0,
        heightMm: 2.94,
        bottom,
        bounds: { minX: 16.25, maxX: 23.75, minY: 0, maxY: 5 },
      },
    ],
    connectors: [
      {
        ref: "J1",
        footprint: "Connector_USB:USB_Micro-B_Molex-105017-0001",
        edge: "minY",
        x: 20,
        y: 0,
        widthMm: 7.5,
        heightMm: 2.94,
        face: {
          bounds: { minX: 16.25, maxX: 23.75, minY: 0, maxY: 5 },
          centerZ: 1.47,
          heightMm: 2.94,
          source: "Molex 105017-0001 catalog maximum",
        },
      },
    ],
  };
  const design = defaultEnclosureDesign(features);
  return { design, boards: [{ placement: design.boards[0]!, features }] };
}

test("preview follows moved and rotated ports on either side of a PCB", () => {
  for (const bottom of [false, true])
    for (const rotation of [0, 90, 180, 270, -90, 360]) {
      const { design, boards } = fixture(bottom);
      design.boards[0] = { ...design.boards[0]!, x: 100, y: 70, z: 12, rotation };
      const original = structuredClone(design);
      const result = prepareEnclosurePreview(design, boards, "keep");
      const o = result.openings[0]!;
      const normalized = ((rotation % 360) + 360) % 360;
      expect(o.wall).toBe(
        ({ 0: "minY", 90: "maxX", 180: "maxY", 270: "minX" } as const)[normalized as 0],
      );
      const angle = (rotation * Math.PI) / 180;
      const x = 100 + 20 * Math.cos(angle) - 2.5 * Math.sin(angle);
      const y = 70 + 20 * Math.sin(angle) + 2.5 * Math.cos(angle);
      expect(o.offset).toBeCloseTo(o.wall.endsWith("X") ? y : x);
      expect(o.z).toBeCloseTo(12 + (bottom ? -2.94 : 1.6) - 0.4);
      expect(o.height).toBeCloseTo(3.74);
      expect(o.width).toBeCloseTo(8.3);
      expect(design).toEqual(original);
      expect(MechanicalDesignSchema.parse(result).openings[0]!.followBoard).toBe(true);
    }
});

test("custom openings and legacy saved sizes survive refresh until explicitly matched", () => {
  const { design, boards } = fixture();
  const { followBoard: _, ...legacy } = { ...design.openings[0]!, height: 7.8 };
  design.openings = [legacy, { ...legacy, name: "Custom", followBoard: false }];
  expect(refreshEnclosureOpenings(design, boards).openings).toEqual(design.openings);
  design.openings[0]!.followBoard = true;
  const updated = refreshEnclosureOpenings(design, boards);
  expect(updated.openings[0]!.height).toBeCloseTo(3.74);
  expect(updated.openings[1]!.height).toBe(7.8);
});

test("port face overrides and tolerance apply consistently when refreshing", () => {
  const { design, boards } = fixture();
  design.fitAllowance = 0.1;
  design.openingClearance = 0.25;
  design.portAccess = [
    {
      boardPath: "board.kicad_pcb",
      ref: "J1",
      access: "external",
      face: "maxX",
      aperture: { width: 6, height: 2, shape: "rounded" },
    },
  ];
  const o = refreshEnclosureOpenings(design, boards).openings[0]!;
  expect(o.wall).toBe("maxX");
  expect(o.width).toBeCloseTo(6.9);
  expect(o.height).toBeCloseTo(2.9);
  expect(o.shape).toBe("rounded");
});

test("internal ports no longer leave an automatic hole in the case", () => {
  const { design, boards } = fixture();
  design.portAccess = [{ boardPath: "board.kicad_pcb", ref: "J1", access: "internal" }];
  expect(refreshEnclosureOpenings(design, boards).openings).toEqual([]);
});

test("missing data or oblique ports cannot silently leave a stale automatic opening", () => {
  const { design, boards } = fixture();
  expect(() => refreshEnclosureOpenings(design, [])).toThrow("Reload");
  design.boards[0]!.rotation = 45;
  expect(() => refreshEnclosureOpenings(design, boards)).toThrow("faces a wall");
});

test("auto layout respects custom linked cutouts without adding a duplicate or resizing walls", () => {
  const { design, boards } = fixture();
  design.openings[0]!.followBoard = false;
  design.openings[0]!.height = 4.2;
  const result = proposeEnclosureLayout(design, boards).design;
  expect(result.openings).toEqual(design.openings);
  expect(result.boards).toEqual(design.boards);
  expect(result.space).toEqual(design.space);
  expect(() => resizeEnclosureToFit(design)).toThrow("manual openings");
});
