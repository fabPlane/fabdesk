import { expect, test } from "bun:test";
import { selectDiffGeometry } from "./diff-selection";
import { parseSvgViewBox } from "./svg-coords";

const part = (ref: string, x: number) => `<g data-ref="${ref}"><rect x="${x}" y="20" width="2" height="2"/></g>`;
const source = `<svg viewBox="0 0 100 80">${part("R1", 10)}${part("R2", 50)}${part("R1", 14)}</svg>`;

test("selecting a moved part highlights both positions and focuses their shared region", () => {
  const result = selectDiffGeometry(source, { kind: "part", id: "R1" });
  expect(result.found).toBe(true);
  expect(result.svg.match(/data-diff-selected="true"/g)).toHaveLength(2);
  const box = parseSvgViewBox(result.svg)!;
  expect(box.x).toBeLessThan(10);
  expect(box.x + box.width).toBeGreaterThan(16);
  expect(box.width).toBeLessThan(100);
  expect(result.svg).toContain('<g data-ref="R2">');
});

test("side-by-side focuses each panel while preserving the outer two-panel layout", () => {
  const svg = `<svg viewBox="0 0 220 100"><svg x="0" y="10" width="100" height="80" viewBox="0 0 50 40">${part("R1", 10)}</svg><svg x="110" y="10" width="100" height="80" viewBox="0 0 50 40">${part("R1", 15)}</svg></svg>`;
  const result = selectDiffGeometry(svg, { kind: "part", id: "R1" });
  expect(result.svg.match(/data-diff-selected="true"/g)).toHaveLength(2);
  expect(parseSvgViewBox(result.svg)).toEqual({ x: 0, y: 0, width: 220, height: 100 });
  const panels = [...result.svg.matchAll(/<svg x=[^>]*>/g)].map(match => parseSvgViewBox(match[0])!);
  expect(panels).toHaveLength(2);
  expect(panels[0]!.width).toBeLessThan(50);
  expect(panels[1]!.width).toBeLessThan(50);
  expect(panels[0]!.x).toBeLessThan(10);
  expect(panels[1]!.x + panels[1]!.width).toBeGreaterThan(17);
});

test("net selection includes its copper and connected component locations", () => {
  const svg = `<svg viewBox="0 0 100 80">${part("R1", 10)}<line data-net="VCC" x1="10" y1="10" x2="40" y2="15"/><line data-net="GND" x1="70" y1="70" x2="90" y2="70"/></svg>`;
  const result = selectDiffGeometry(svg, { kind: "net", id: "VCC", refs: ["R1"] });
  expect(result.found).toBe(true);
  expect(result.svg.match(/data-diff-selected="true"/g)).toHaveLength(2);
  expect(parseSvgViewBox(result.svg)!.width).toBeLessThan(50);
});

test("clear, missing surface geometry, and hostile names never invent SVG or CSS", () => {
  expect(selectDiffGeometry(source, null).svg).toBe(source);
  expect(selectDiffGeometry(source, { kind: "part", id: "absent" })).toEqual({ svg: source, found: false });
  expect(selectDiffGeometry(source, { kind: "part", id: 'R1"] { fill:red; } <script>' })).toEqual({ svg: source, found: false });
  const escaped = '<svg viewBox="0 0 10 10"><g data-ref="R&amp;1"><rect x="1" y="1" width="1" height="1"/></g></svg>';
  expect(selectDiffGeometry(escaped, { kind: "part", id: "R&1" }).found).toBe(true);
});
