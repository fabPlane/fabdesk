import { expect, test } from "bun:test";
import { createBoardGraphic } from "@fp-pcb/client";
import { BoardLayer } from "@fp-pcb/proto";
import { resizeNativeOutlineShapes, nativeGroupLocksAny } from "./pcb-outline-resize";
const rectangle = () => createBoardGraphic({ id: "human-rectangle", layer: BoardLayer.BL_Edge_Cuts, strokeWidth: 50_000, geometry: { kind: "rectangle", topLeft: { x: 100_000_000, y: 95_000_000 }, bottomRight: { x: 115_000_000, y: 110_000_000 } } });
const corners = [{ x: 100_000_000, y: 95_000_000 }, { x: 115_000_000, y: 95_000_000 }, { x: 115_000_000, y: 110_000_000 }, { x: 100_000_000, y: 110_000_000 }];
const segments = () => corners.map((start, index) => createBoardGraphic({ id: `edge-${index}`, layer: BoardLayer.BL_Edge_Cuts, strokeWidth: 37_000, geometry: { kind: "segment", start, end: corners[(index + 1) % 4]! } }));
test("an imported native rectangle keeps its ID, metadata and complete non-geometry proto", () => {
  const original = rectangle(); original.setCustomProperty("review-note", "human-authored; preserve me");
  const before = original.toJson(), result = resizeNativeOutlineShapes([original], 22, 16), updated = result.updates[0]!;
  expect(result.bounds).toEqual({ minX: 100, minY: 95, maxX: 122, maxY: 111 });
  expect(updated.id).toBe(original.id); expect(updated.start).toEqual({ x: 100_000_000, y: 95_000_000 }); expect(updated.end).toEqual({ x: 122_000_000, y: 111_000_000 });
  expect(updated.customProperties).toEqual(original.customProperties); expect(updated.strokeWidth).toBe(50_000);
  const geometry = updated.proto.shape!.geometry; updated.proto.shape!.geometry = original.proto.shape!.geometry;
  expect(updated.proto).toEqual(original.proto); updated.proto.shape!.geometry = geometry;
  expect(original.toJson()).toEqual(before);
});
test("four human-authored segments are updated in place with their direction and IDs preserved", () => {
  const original = segments(), before = original.map(edge => edge.toJson()), result = resizeNativeOutlineShapes(original, 20, 10);
  expect(result.updates.map(edge => edge.id)).toEqual(original.map(edge => edge.id));
  expect(result.updates.map(edge => ({ start: edge.start, end: edge.end }))).toEqual([
    { start: { x: 100_000_000, y: 95_000_000 }, end: { x: 120_000_000, y: 95_000_000 } },
    { start: { x: 120_000_000, y: 95_000_000 }, end: { x: 120_000_000, y: 105_000_000 } },
    { start: { x: 120_000_000, y: 105_000_000 }, end: { x: 100_000_000, y: 105_000_000 } },
    { start: { x: 100_000_000, y: 105_000_000 }, end: { x: 100_000_000, y: 95_000_000 } },
  ]);
  expect(original.map(edge => edge.toJson())).toEqual(before); expect(result.updates.every(edge => edge.strokeWidth === 37_000)).toBe(true);
});
test("locked, partial, duplicate, curved and diagonal boundaries cannot use simple resizing", () => {
  const locked = rectangle(); locked.locked = true;
  expect(() => resizeNativeOutlineShapes([locked], 20, 10)).toThrow("Unlock");
  expect(() => resizeNativeOutlineShapes(segments().slice(0, 3), 20, 10)).toThrow("complete");
  const duplicate = segments(); duplicate[1] = duplicate[0]!;
  expect(() => resizeNativeOutlineShapes(duplicate, 20, 10)).toThrow();
  const diagonal = segments(); diagonal[0] = createBoardGraphic({ id: "diagonal", layer: BoardLayer.BL_Edge_Cuts, geometry: { kind: "segment", start: corners[0]!, end: corners[2]! } });
  expect(() => resizeNativeOutlineShapes(diagonal, 20, 10)).toThrow("axis-aligned");
  const circle = createBoardGraphic({ layer: BoardLayer.BL_Edge_Cuts, geometry: { kind: "circle", center: { x: 0, y: 0 }, radiusPoint: { x: 1_000_000, y: 0 } } });
  expect(() => resizeNativeOutlineShapes([circle], 20, 10)).toThrow("rectangle");
});
test("dimensions have native resolution bounds and unchanged sizes need no mutation", () => {
  for (const width of [0, -1, .0000001, Infinity, 1001]) expect(() => resizeNativeOutlineShapes([rectangle()], width, 15)).toThrow("dimensions");
  expect(resizeNativeOutlineShapes([rectangle()], 15, 15).changed).toBe(false);
});

test("missing native endpoint messages cannot silently become an origin at zero", () => {
  const malformed = rectangle(), geometry = malformed.proto.shape!.geometry;
  if (geometry.case === "rectangle") geometry.value.topLeft = undefined;
  expect(() => resizeNativeOutlineShapes([malformed], 20, 10)).toThrow("incomplete endpoint");
});

test("locked ancestor groups protect native edges while unlocked grouping stays intact", () => {
  const groups = [{ id: "outer", items: ["inner"], locked: true }, { id: "inner", items: ["edge"], locked: false }];
  expect(nativeGroupLocksAny(["edge"], groups)).toBe(true);
  expect(nativeGroupLocksAny(["unrelated"], groups)).toBe(false);
  expect(nativeGroupLocksAny(["edge"], groups.map(group => ({ ...group, locked: false })))).toBe(false);
  expect(nativeGroupLocksAny(["edge"], [{ id: "a", items: ["edge", "b"], locked: false }, { id: "b", items: ["a"], locked: false }])).toBe(false);
});
