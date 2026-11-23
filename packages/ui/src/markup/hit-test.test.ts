import { expect, test } from "bun:test";
import { objectsInMarkupRegion } from "./hit-test";

const schematic = `<svg viewBox="0 0 200 120">
  <g data-ref="R1"><rect x="10" y="10" width="20" height="10"/></g>
  <g data-ref="U1"><rect x="80" y="40" width="30" height="20"/></g>
  <g data-net="VCC"><line x1="10" y1="15" x2="80" y2="50"/></g>
  <g data-net="GND"><line x1="150" y1="90" x2="180" y2="90"/></g>
</svg>`;

const pcb = `<svg viewBox="0 0 100 80" data-fabplane-coordinate-system="kicad-pcb-mm-v1">
  <g data-ref="C1"><rect x="5" y="5" width="8" height="8"/></g>
  <g data-ref="J1"><circle cx="70" cy="40" r="4"/></g>
  <g data-net="USB_DP"><polyline points="70,40 90,40"/></g>
</svg>`;

test("schematic region hit-test returns nearby refdes and nets", () => {
  const aroundR1 = objectsInMarkupRegion(schematic, { x: 8, y: 8, w: 24, h: 16 });
  expect(aroundR1.refdes).toEqual(["R1"]);
  expect(aroundR1.nets).toEqual(["VCC"]);
  const aroundU1 = objectsInMarkupRegion(schematic, { x: 78, y: 38, w: 36, h: 24 });
  expect(aroundU1.refdes).toContain("U1");
  expect(aroundU1.refdes).not.toContain("R1");
  const empty = objectsInMarkupRegion(schematic, { x: 0, y: 100, w: 4, h: 4 });
  expect(empty.refdes).toEqual([]);
  expect(empty.nets).toEqual([]);
});

test("PCB millimetre SVG hit-test finds footprints and nets in the marked box", () => {
  const cap = objectsInMarkupRegion(pcb, { x: 4, y: 4, w: 12, h: 12 });
  expect(cap.refdes).toEqual(["C1"]);
  const connector = objectsInMarkupRegion(pcb, { x: 64, y: 34, w: 30, h: 14 });
  expect(connector.refdes).toEqual(["J1"]);
  expect(connector.nets).toEqual(["USB_DP"]);
});
