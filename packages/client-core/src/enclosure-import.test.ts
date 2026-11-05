import { expect, test } from "bun:test";
import { validateEnclosureFile } from "./enclosure-design";

test("enclosure imports accept STL and STEP but reject empty, oversized and unrelated files", () => {
  for (const name of ["case.stl", "CASE.STEP", "case.stp"])
    expect(() => validateEnclosureFile(name, 1024)).not.toThrow();
  for (const size of [0, -1, NaN, Infinity, 50 * 1024 * 1024 + 1])
    expect(() => validateEnclosureFile("case.stl", size)).toThrow();
  for (const name of ["case.obj", "case.stl.exe", "case", "case.glb"])
    expect(() => validateEnclosureFile(name, 1024)).toThrow("STL or STEP");
});
