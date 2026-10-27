import { expect, test } from "bun:test";
import { cropNativePageSvg } from "../src/pcb-svg-coordinates";
const svg = '<svg width="297mm" height="210mm" viewBox="0 0 297 210"><path d="M 105 100 L 110 100"/></svg>';
test("cropping preserves native geometry and a nonzero PCB origin", () => {
  const cropped = cropNativePageSvg(svg, { minX: 100, minY: 95, maxX: 115, maxY: 110 });
  expect(cropped).toContain('viewBox="98 93 19 19"');
  expect(cropped).toContain('d="M 105 100 L 110 100"');
  expect(cropped).toContain('data-fabplane-coordinate-system="kicad-pcb-mm-v1"');
});
test("negative origins stay negative; unavailable outlines retain the current page", () => {
  expect(cropNativePageSvg(svg, { minX: -20, minY: -25, maxX: -5, maxY: -10 })).toContain('viewBox="-22 -27 19 19"');
  expect(cropNativePageSvg(svg)).toContain('viewBox="0 0 297 210"');
});
test("unverified physical scales and invalid bounds cannot receive a native coordinate stamp", () => {
  expect(() => cropNativePageSvg(svg.replace('width="297mm"', 'width="100mm"'))).toThrow("scale");
  expect(() => cropNativePageSvg(svg, { minX: 2, minY: 3, maxX: 1, maxY: 5 })).toThrow("bounds");
});
