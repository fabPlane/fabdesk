import { expect, test } from "bun:test";
import { enclosureSizeLabel } from "./enclosure-display";

test("saved dimensions supply a size without an alignment or fit claim", () => {
  expect(enclosureSizeLabel({ width: 21, depth: 21, height: 16.10000001 })).toBe("21 × 21 × 16.1 mm");
  for (const invalid of [undefined, null, [], "21 × 21", {}, { width: 21, depth: 21 }, { width: "21", depth: 21, height: 16 }, { width: 0, depth: 21, height: 16 }, { width: 21, depth: NaN, height: 16 }, { width: 21, depth: 21, height: Infinity }]) expect(enclosureSizeLabel(invalid)).toBeNull();
});
