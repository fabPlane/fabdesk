import { expect, test } from "bun:test";
import { defaultEnclosureDesign } from "./enclosure-design";
import {
  enclosureSourceBoards,
  prepareEnclosurePreview,
  selectEnclosureBoards,
} from "./enclosure-setup";
import { nativeEnclosureClearanceIssues, type LayoutBoard } from "./enclosure-layout";

const board: LayoutBoard = {
  placement: { path: "usb.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 },
  features: {
    pcbRevision: "rev",
    thicknessMm: 1.6,
    outline: { minX: 0, minY: 0, maxX: 40, maxY: 20, widthMm: 40, heightMm: 20 },
    holes: [],
  },
  modelBounds: { minX: -1, minY: 0, maxX: 41, maxY: 20, minZ: -2, maxZ: 12 },
};
test("new case reaches a native-clearance-safe preview without entering dimensions", () => {
  const d = selectEnclosureBoards(defaultEnclosureDesign(null), [board.placement.path]);
  const result = prepareEnclosurePreview(d, [board], "compact");
  expect(d.confirmed).toBe(false);
  expect(result.confirmed).toBe(true);
  expect(result.space.width).toBeLessThan(100);
  expect(
    nativeEnclosureClearanceIssues(result, [{ ...board, placement: result.boards[0]! }]),
  ).toEqual([]);
});
test("existing-case measurements are never silently confirmed and keep mode preserves placements", () => {
  const d = selectEnclosureBoards(defaultEnclosureDesign(null), [board.placement.path]);
  const imported = {
    ...d,
    mode: "imported" as const,
    source: {
      path: "case.stl",
      scale: 1,
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
    },
  };
  expect(() => prepareEnclosurePreview(imported, [board], "compact")).toThrow("inside dimensions");
  expect(
    prepareEnclosurePreview({ ...imported, confirmed: true }, [board], "compact").boards,
  ).toEqual(d.boards);
  expect(prepareEnclosurePreview(d, [board], "keep")).toEqual({ ...d, confirmed: true });
  expect(() => prepareEnclosurePreview(defaultEnclosureDesign(null), [], "compact")).toThrow(
    "Choose at least one",
  );
});
test("unselecting a board removes only its linked settings, keeping other work", () => {
  const d = selectEnclosureBoards(defaultEnclosureDesign(null), ["a.kicad_pcb", "b.kicad_pcb"]);
  d.boards[0]!.locked = true;
  d.mounts = [
    { boardPath: "b.kicad_pcb", x: 5, y: 5, diameter: 2, outer: 5, height: 3 },
    { x: 10, y: 10, diameter: 2, outer: 5, height: 3 },
  ];
  d.connections = [
    {
      id: "ab",
      from: { boardPath: "a.kicad_pcb", ref: "J1" },
      to: { boardPath: "b.kicad_pcb", ref: "J2" },
      length: 100,
      slack: 10,
    },
  ];
  d.portAccess = [
    { boardPath: "a.kicad_pcb", ref: "J1", access: "internal" },
    { boardPath: "b.kicad_pcb", ref: "J2", access: "internal" },
  ];
  const next = selectEnclosureBoards(d, ["a.kicad_pcb"]);
  expect(next.boards).toEqual([d.boards[0]!]);
  expect(next.mounts).toEqual([d.mounts[1]!]);
  expect(next.connections).toEqual([]);
  expect(next.portAccess).toEqual([d.portAccess[0]!]);
  expect(d.connections).toHaveLength(1);
});
test("board picker excludes generated exports without hiding existing selections", () => {
  expect(() =>
    selectEnclosureBoards(
      defaultEnclosureDesign(null),
      Array.from({ length: 21 }, (_, i) => `${i}.kicad_pcb`),
    ),
  ).toThrow("up to 20");
  expect(
    enclosureSourceBoards(
      [
        "a.kicad_pcb",
        "exports/boards/a.kicad_pcb",
        "cad/model.stl",
        "vendor/demo.kicad_pcb",
        "hardware/B.KICAD_PCB",
      ],
      ["gone.kicad_pcb"],
    ),
  ).toEqual(["a.kicad_pcb", "gone.kicad_pcb", "hardware/B.KICAD_PCB"]);
});
