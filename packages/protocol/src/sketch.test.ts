import { expect, test } from "bun:test";
import { isEditableSketchSource } from "./sketch";
test("drawing source envelope accepts supported scenes without stripping original or future fields", () => {
  expect(isEditableSketchSource(JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: "shape", type: "rectangle" }], appState: {}, custom: "kept" }))).toBe(true);
  for (const input of ["null", "{}", "not json", '{"type":"excalidrawlib","version":2,"elements":[]}', '{"type":"excalidraw","version":1,"elements":[]}', '{"type":"excalidraw","version":2,"elements":[null]}', JSON.stringify({ type: "excalidraw", version: 2, elements: Array(10_001).fill({}) })]) expect(isEditableSketchSource(input)).toBe(false);
});
