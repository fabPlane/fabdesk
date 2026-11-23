import { expect, test } from "bun:test";
import { combineBoardLayers } from "./BoardPreview";
test("layer visibility preserves the shared coordinate frame and excludes hidden layers", () => {
  const layers = ["F.Cu", "B.Cu"].map(name => ({ name, svg: `<?xml version="1.0"?><svg viewBox="10 20 40 60"><path id="${name}"/></svg>` }));
  expect(combineBoardLayers(layers, new Set(["F.Cu"]))).toBe('<svg viewBox="10 20 40 60"><g><path id="B.Cu"/></g></svg>');
  expect(combineBoardLayers(layers, new Set(["F.Cu", "B.Cu"]))).toBe('<svg viewBox="10 20 40 60"></svg>');
});
