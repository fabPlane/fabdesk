import { expect, test } from "bun:test";
import { MechanicalDesignSchema } from "@fabdesk/protocol";
import { defaultEnclosureDesign } from "./enclosure-design";
import { proposeEnclosureLayout, type LayoutBoard } from "./enclosure-layout";
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
test("unlinked manual mounting points require explicit review", () => {
  const b = fixture("one.kicad_pcb"),
    d = defaultEnclosureDesign(null);
  d.boards = [b.placement];
  d.mounts = [{ x: 0, y: 0, diameter: 2, outer: 5, height: 4 }];
  expect(() => proposeEnclosureLayout(d, [b])).toThrow("Link manual posts");
});
