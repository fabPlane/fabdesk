import { expect, test } from "bun:test";
import {
  addStroke,
  arrowHead,
  boxesIntersect,
  clearStrokes,
  emptyStrokes,
  extendPen,
  replaceStroke,
  strokeBounds,
  undoStroke,
  type ArrowStroke,
  type PenStroke,
} from "./strokes";

const pen = (id: string, points: Array<{ x: number; y: number }>): PenStroke => ({ id, tool: "pen", points });
const arrow = (id: string, from: { x: number; y: number }, to: { x: number; y: number }): ArrowStroke => ({
  id,
  tool: "arrow",
  from,
  to,
});

test("add, undo and clear keep the stroke list in order", () => {
  let model = emptyStrokes();
  model = addStroke(model, pen("a", [{ x: 0, y: 0 }, { x: 4, y: 0 }]));
  model = addStroke(model, arrow("b", { x: 1, y: 1 }, { x: 8, y: 8 }));
  expect(model.strokes.map((s) => s.id)).toEqual(["a", "b"]);
  model = undoStroke(model);
  expect(model.strokes.map((s) => s.id)).toEqual(["a"]);
  model = undoStroke(model);
  expect(model.strokes).toEqual([]);
  expect(undoStroke(model).strokes).toEqual([]);
  model = addStroke(model, pen("c", [{ x: 2, y: 2 }]));
  expect(clearStrokes(model).strokes).toEqual([]);
});

test("extendPen drops duplicate consecutive points and replaceStroke updates the live stroke", () => {
  const start = pen("live", [{ x: 0, y: 0 }]);
  expect(extendPen(start, { x: 0, y: 0 }).points).toHaveLength(1);
  const longer = extendPen(start, { x: 3, y: 4 });
  expect(longer.points).toEqual([{ x: 0, y: 0 }, { x: 3, y: 4 }]);
  const model = replaceStroke(addStroke(emptyStrokes(), start), longer);
  expect(model.strokes).toEqual([longer]);
});

test("strokeBounds covers pen points and the arrow head, and boxesIntersect is AABB", () => {
  const bounds = strokeBounds([pen("a", [{ x: 10, y: 10 }, { x: 20, y: 10 }])]);
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeLessThan(10);
  expect(bounds!.x + bounds!.w).toBeGreaterThan(20);
  const head = arrowHead({ x: 0, y: 0 }, { x: 20, y: 0 }, 10);
  expect(head[0]).toEqual({ x: 20, y: 0 });
  expect(head[1]!.x).toBeLessThan(20);
  expect(head[2]!.x).toBeLessThan(20);
  expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 2, h: 2 })).toBe(true);
  expect(boxesIntersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 11, y: 0, w: 2, h: 2 })).toBe(false);
});
