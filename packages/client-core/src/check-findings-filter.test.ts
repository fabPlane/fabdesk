import { expect, test } from "bun:test";
import { filterCheckFindings, type Violation } from "./check-findings";
const rows: Violation[] = [
  { source: "drc", type: "clearance", severity: "error", description: "Copper clearance", items: [{ description: "Pad 1 of U1" }] },
  { source: "erc", type: "pin_not_connected", severity: "warning", description: "Unconnected pin", items: [{ description: "J4 pin 2" }] },
  { source: "drc", type: "hole_to_hole", severity: "warning", description: "Drilled holes too close", items: [{ description: "J4 mounting hole", pos: { x: 4, y: 8 } }] },
  { source: "drc", type: "custom", severity: "info", description: "Custom information", items: [] },
];
test("filtered findings retain their original report index and exact item reference", () => {
  const result = filterCheckFindings(rows, { query: "HOLE   j4", severity: "warning" });
  expect(result.map(row => row.index)).toEqual([2]);
  expect(result[0]!.finding).toBe(rows[2]!);
  expect(result[0]!.finding.items[0]!.pos).toEqual({ x: 4, y: 8 });
});
test("source and severity filters combine without losing unknown severities from the all view", () => {
  expect(filterCheckFindings(rows, { source: "drc", severity: "WARNING" }).map(row => row.index)).toEqual([2]);
  expect(filterCheckFindings(rows, { source: "erc" }).map(row => row.index)).toEqual([1]);
  expect(filterCheckFindings(rows, { severity: "info" }).map(row => row.index)).toEqual([3]);
  expect(filterCheckFindings(rows, { query: "  ", severity: "all" }).map(row => row.index)).toEqual([0, 1, 2, 3]);
});
test("search matches component details and rules; unmatched filters stay empty rather than implying no saved findings", () => {
  expect(filterCheckFindings(rows, { query: "u1 clearance" }).map(row => row.index)).toEqual([0]);
  expect(filterCheckFindings(rows, { query: "pin_not_connected" }).map(row => row.index)).toEqual([1]);
  expect(filterCheckFindings(rows, { query: "does-not-exist" })).toEqual([]);
  expect(filterCheckFindings([], { query: "U1" })).toEqual([]);
});
test("filtering does not mutate the report or reorder saved findings", () => {
  const before = JSON.stringify(rows), frozen = Object.freeze([...rows]);
  expect(filterCheckFindings(frozen).map(row => row.index)).toEqual([0, 1, 2, 3]);
  expect(JSON.stringify(rows)).toBe(before);
});

test("warnings from the exporter cannot bury errors or retarget a sorted selection", () => {
  const report = Object.freeze([rows[2]!, rows[0]!, rows[3]!, { ...rows[0]!, severity: "ERROR", description: "Missing connection", items: [{ description: "Pad R1", pos: { x: 10, y: 20 } }] }, rows[1]!]);
  const display = filterCheckFindings(report);
  expect(display.map(row => row.index)).toEqual([1, 3, 0, 4, 2]);
  expect(report[display[1]!.index]).toBe(display[1]!.finding);
  expect(display[1]!.finding.items[0]?.pos).toEqual({ x: 10, y: 20 });
  expect(filterCheckFindings(report, { query: "R1" }).map(row => row.index)).toEqual([3]);
  expect(filterCheckFindings(report, { severity: "warning" }).map(row => row.index)).toEqual([0, 4]);
  expect(report[0]).toBe(rows[2]!);
});
