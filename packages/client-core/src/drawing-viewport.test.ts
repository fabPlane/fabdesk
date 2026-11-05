import { expect, test } from "bun:test";
import { DrawingViewportMemory } from "./drawing-viewport";
test("view memory separates boards/endpoints, rejects changed drawings and bounds old history", () => {
  const memory = new DrawingViewportMemory(2), position = { zoom: 2, left: 100, top: 50 };
  memory.save("local/p/io/sheet1", "svg", position); position.left = 999;
  expect(memory.read("local/p/io/sheet1", "svg")).toEqual({ zoom: 2, left: 100, top: 50 });
  expect(memory.read("remote/p/io/sheet1", "svg")).toBeNull();
  expect(memory.read("local/p/io/sheet1", "edited svg")).toBeNull();
  memory.save("b", "svg", position); memory.read("local/p/io/sheet1", "svg"); memory.save("c", "svg", position);
  expect(memory.read("b", "svg")).toBeNull();
  memory.save("invalid", "svg", { zoom: NaN, left: 0, top: 0 }); expect(memory.read("invalid", "svg")).toBeNull();
});
