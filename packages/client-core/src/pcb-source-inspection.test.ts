import { expect, test } from "bun:test";
import { inspectPcbParts, pcbToolJsonForSource } from "./pcb-parts";
import { inspectPcbOutline } from "./pcb-outline";
const board = { sourceId: "a", manifestSha256: "a".repeat(64) };
const owner = { projectId: "project", ...board };
const body = () => ({ _board: owner, contract: { name: "fabdesk.pcb-inspection", version: "2.0.0" }, revision: "b".repeat(64), coordinateSystem: { units: "mm", origin: "KiCad board origin", x: "right", y: "down" }, results: { components: { total: 1, returned: 1, truncated: false, rows: [{ ref: "R1", value: "1k", footprint: "R_0402", x: 105, y: 100, rotation: 0, locked: false, flipped: false }] }, board_geometry: { total: 1, returned: 1, truncated: false, rows: [{ id: "edge", owner: "board", kind: "rectangle", layer: 47, locked: false, toolOwnedOutline: false, start: { x: 100, y: 95 }, end: { x: 115, y: 110 } }] } } });
const response = (json: unknown) => ({ result: { ok: true, text: "", json } });
test("part and outline inspection capture source ownership independently of later caller changes", async () => {
  for (const kind of ["parts", "outline"] as const) {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; }), selection = { ...board }, calls: unknown[] = [];
    const client = { callTool: async (name: string, args: unknown) => { calls.push({ name, args }); await ready; return response(body()); } };
    const pending = kind === "parts" ? inspectPcbParts(client, "project", { reference: "R1" }, selection) : inspectPcbOutline(client, "project", selection);
    selection.sourceId = "b"; selection.manifestSha256 = "c".repeat(64); release();
    const result = await pending; expect(result.sourceSha256).toBe("b".repeat(64));
    expect(calls).toMatchObject([{ name: "pcb_inspect", args: { projectId: "project", board, kinds: [kind === "parts" ? "components" : "board_geometry"] } }]);
  }
});
test("root or wrong-project/source/declaration results never become member facts or saved-edit confirmations", async () => {
  for (const identity of [undefined, { ...owner, projectId: "other" }, { ...owner, sourceId: "b" }, { ...owner, manifestSha256: "c".repeat(64) }]) {
    const result = { ...body(), _board: identity }, client = { callTool: async () => response(result) };
    await expect(inspectPcbParts(client, "project", {}, board)).rejects.toThrow("does not belong");
    await expect(inspectPcbOutline(client, "project", board)).rejects.toThrow("does not belong");
    expect(() => pcbToolJsonForSource(response({ saved: true, _board: identity }), "project", board)).toThrow("does not belong");
  }
});
test("single-board responses retain their legacy behavior while member confirmations require the echoed owner", async () => {
  const result = body(), client = { callTool: async () => response({ ...result, _board: undefined }) };
  expect((await inspectPcbParts(client, "project", {})).parts[0]?.ref).toBe("R1");
  expect((await inspectPcbOutline(client, "project")).bounds).toEqual({ minX: 100, minY: 95, maxX: 115, maxY: 110 });
  expect(pcbToolJsonForSource(response({ saved: true, _board: owner }), "project", board).saved).toBe(true);
});
