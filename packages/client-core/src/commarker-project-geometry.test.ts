import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { studioCopperGeometry } from "./commarker-project-geometry";

const options = { penIndex: 3, fillParam: { layer: [{ enabled: true, penID: 3, fillSpace: 0.1 }] } };
const fixture = (path: string) => readFile(join(import.meta.dir, "../../../docs", path), "utf8");
const svg = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="20mm" height="12mm" viewBox="0 0 20 12">
<title>Front copper to remove</title>
<path fill="#000000" fill-rule="evenodd" stroke="none" d="${d}"/>
</svg>`;

test("generated coupon becomes one editable native shape with separate closed rings and exact mm bounds", async () => {
  const native = studioCopperGeometry(await fixture("examples/omni-x-copper-coupon-remove.svg"), options);
  expect(native.type).toBe(4);
  expect(native.position).toEqual({ from: [-10, -6], to: [20, 12] });
  expect(native.basePaths).toHaveLength(3);
  for (const ring of native.basePaths) {
    expect(ring.type).toBe(1);
    expect(ring.points[0]).toEqual(ring.points.at(-1)!);
    expect(ring.points.length).toBeGreaterThan(3);
  }
  expect(native.penIndex).toBe(3);
  expect(native.fillParam).toEqual(options.fillParam);
  expect(native.matrix).toEqual([1, 0, 0, 1, 0, 0]);
  expect(native.arrayParam.enabled).toBe(false);
});

test("inset bounds and holes retain their registration within the SVG page", async () => {
  const native = studioCopperGeometry(await fixture("validation/commarker-studio/inset-ring-cutout.svg"), options);
  expect(native.position).toEqual({ from: [-7, -7.5], to: [17, 13] });
  expect(native.basePaths).toHaveLength(4);
  const first = studioCopperGeometry(svg("M1.5 2 L3.25 2 L3.25 6 Z"), options).basePaths[0]!;
  expect(first.points).toEqual([[-8.5, 4], [-6.75, 4], [-6.75, 0], [-8.5, 4]]);
});

test("refuses different scales, omitted geometry, unsupported commands and malformed contours", () => {
  const valid = svg("M0 0 L20 0 L20 12 Z");
  for (const invalid of [
    valid.replace("20mm", "20px"), valid.replace("0 0 20 12", "0 0 100 60"),
    valid.replace('stroke="none"', 'transform="scale(2)" stroke="none"'),
    valid.replace("</svg>", '<rect x="0" y="0" width="5" height="5"/></svg>'),
    svg("M0 0 L1 0 C1 2 3 4 5 6 Z"), svg("M0 0 L1 1 L2 2 Z"), svg("M0 0 L21 0 L2 2 Z"),
    svg("M0 0 L1 1 Z"), svg("M0 0 L1 1 L2 4"), svg("M0 0 L1 1 M2 3 L3 3 L4 7 Z"), svg("M0 0 L0 0 L1 1 Z"),
  ]) expect(() => studioCopperGeometry(invalid, options)).toThrow("Prepare the board again");
  expect(() => studioCopperGeometry(valid, { ...options, penIndex: -1 })).toThrow("valid pen");
  expect(() => studioCopperGeometry(" ".repeat(16 * 1024 * 1024 + 1), options)).toThrow("too large");
});
