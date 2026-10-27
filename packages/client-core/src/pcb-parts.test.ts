import { expect, test } from "bun:test";
import { parsePcbPartInspection, parsePartPositionInput, pcbPlacementWarnings, pcbSvgHasNativeCoordinates } from "./pcb-parts";
const row = { ref: "R1", value: "1k", footprint: "R_0402", x: 105, y: 100, rotation: 0, flipped: false, locked: false };
const envelope = (rows: unknown[] = [row]) => ({ ok: true, json: { contract: { name: "fabdesk.pcb-inspection", version: "2.0.0" }, revision: "a".repeat(64), results: { components: { rows, truncated: false } } } });
test("native part data retains the source revision and coordinates across response envelopes", () => {
  expect(parsePcbPartInspection(envelope())).toEqual({ sourceSha256: "a".repeat(64), parts: [row], truncated: false });
  expect(parsePcbPartInspection({ result: envelope() }).parts[0]?.x).toBe(105);
});
test("unknown provenance, ambiguous references and incomplete coordinates cannot drive an edit", () => {
  expect(() => parsePcbPartInspection({ json: {} })).toThrow();
  expect(() => parsePcbPartInspection(envelope([row, row]))).toThrow("Duplicate");
  expect(() => parsePcbPartInspection(envelope([{ ...row, x: null }]))).toThrow();
  expect(() => parsePcbPartInspection({ isError: true, text: "backend unavailable" })).toThrow("backend unavailable");
});
test("empty, partial and unreasonable position inputs cannot silently become zero or infinity", () => {
  expect(parsePartPositionInput({ x: "", y: "1", rotation: "0" })).toBeNull();
  expect(parsePartPositionInput({ x: "2foo", y: "1", rotation: "0" })).toBeNull();
  expect(parsePartPositionInput({ x: "1e99", y: "1", rotation: "0" })).toBeNull();
  expect(parsePartPositionInput({ x: "105.5", y: "100", rotation: "-90" })).toEqual({ x: 105.5, y: 100, rotation: 270 });
});
test("placement warnings preserve affected-copper and possible-short findings without claiming a full DRC pass", () => {
  expect(pcbPlacementWarnings({ json: { staleCopper: { R1: { staleCount: 2, shortedCount: 1 }, J1: { staleCount: 3, shortedCount: 0 } } } })).toEqual({ affectedCopper: 5, possibleShorts: 1 });
});


test("native part tools require an exporter stamp on the SVG root, not inferred pixel dimensions", () => {
  expect(pcbSvgHasNativeCoordinates('<svg viewBox="0 0 15 15"><path /></svg>')).toBe(false);
  expect(pcbSvgHasNativeCoordinates('<svg><g data-fabplane-coordinate-system="kicad-pcb-mm-v1" /></svg>')).toBe(false);
  expect(pcbSvgHasNativeCoordinates('<svg viewBox="98 93 19 19" data-fabplane-coordinate-system="kicad-pcb-mm-v1"></svg>')).toBe(true);
});
