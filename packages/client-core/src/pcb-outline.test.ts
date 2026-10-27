import { expect, test } from "bun:test";
import { parsePcbOutlineInspection, resizedOutlinePoints, inspectPcbOutline } from "./pcb-outline";
const points = [{ x: 100, y: 95 }, { x: 115, y: 95 }, { x: 115, y: 110 }, { x: 100, y: 110 }];
const rows = points.map((start, i) => ({ id: String(i), owner: "board", layer: 47, kind: "segment", locked: false, toolOwnedOutline: true, start, end: points[(i + 1) % 4] }));
const inspection = (items: unknown[] = rows, truncated = false) => ({ json: { contract: { name: "fabdesk.pcb-inspection", version: "2.0.0" }, revision: "a".repeat(64), coordinateSystem: { units: "mm", origin: "KiCad board origin", x: "right", y: "down" }, results: { board_geometry: { total: items.length, returned: items.length, truncated, rows: items } } } });
test("a complete owned rectangle retains its native origin during width/height changes", () => {
  const result = parsePcbOutlineInspection(inspection());
  expect(result.editable).toBe(true);
  expect(result.bounds).toEqual({ minX: 100, minY: 95, maxX: 115, maxY: 110 });
  expect(resizedOutlinePoints(result.bounds, "20", "10")).toEqual([{ x: 100, y: 95 }, { x: 120, y: 95 }, { x: 120, y: 105 }, { x: 100, y: 105 }]);
});
test("unknown locks/IDs, curved edges and truncated inspection stay read-only", () => {
  for (const items of [rows.map(r => ({ ...r, locked: undefined })), rows.map(r => ({ ...r, id: undefined })), rows.map(r => ({ ...r, kind: "arc" })), rows.map(r => ({ ...r, locked: true }))]) expect(parsePcbOutlineInspection(inspection(items)).editable).toBe(false);
  expect(parsePcbOutlineInspection(inspection(rows, true)).editable).toBe(false);
});
test("disconnected, diagonal, duplicate edges and degenerate loops cannot masquerade as rectangles", () => {
  expect(parsePcbOutlineInspection(inspection([rows[0], rows[0], rows[2], rows[3]])).editable).toBe(false);
  expect(parsePcbOutlineInspection(inspection(rows.map((r, i) => i === 0 ? { ...r, end: points[2] } : r))).editable).toBe(false);
  expect(parsePcbOutlineInspection(inspection(rows.map(r => ({ ...r, end: r.start })))).editable).toBe(false);
});
test("empty native boards need explicit dimensions; invalid values cannot turn into destructive zero-size outlines", () => {
  expect(parsePcbOutlineInspection(inspection([]))).toMatchObject({ editable: true, bounds: null });
  for (const [w, h] of [["", "10"], ["10", ""], ["0", "5"], ["-1", "5"], ["5foo", "4"], ["Infinity", "4"], ["1001", "5"], ["0.0000001", "5"]]) expect(resizedOutlinePoints(null, w!, h!)).toBeNull();
  expect(resizedOutlinePoints(null, "20", "10")?.[2]).toEqual({ x: 20, y: 10 });
});

test("outline inspection uses the native Edge.Cuts enum to avoid unsupported string-alias filtering", async () => {
  let args: unknown;
  await inspectPcbOutline({ callTool: (async (_name: string, input: unknown) => { args = input; return inspection(); }) as never }, "p1");
  expect(args).toEqual({ projectId: "p1", kinds: ["board_geometry"], layers: [47], limitPerKind: 200 });
});

test("simple imported rectangles and human-authored segment boundaries retain the exact native edge IDs", () => {
  const rectangle = { ...rows[0], id: "imported-rectangle", toolOwnedOutline: false, kind: "rectangle", start: points[0], end: points[2] };
  expect(parsePcbOutlineInspection(inspection([rectangle]))).toMatchObject({ editable: true, edgeIds: ["imported-rectangle"], bounds: { minX: 100, minY: 95, maxX: 115, maxY: 110 } });
  expect(parsePcbOutlineInspection(inspection(rows.map(row => ({ ...row, toolOwnedOutline: false }))))).toMatchObject({ editable: true, edgeIds: ["0", "1", "2", "3"] });
});

test("unknown outline frames and unexpected layers never produce editable dimensions", () => {
  const response = inspection();
  expect(() => parsePcbOutlineInspection({ json: { ...response.json, coordinateSystem: { ...response.json.coordinateSystem, y: "up" } } })).toThrow();
  expect(parsePcbOutlineInspection(inspection(rows.map(row => ({ ...row, layer: 3 })))).editable).toBe(false);
});
