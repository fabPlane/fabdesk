import { expect, test } from "bun:test";
import { captureAssemblySchematicInspection } from "./assembly-schematic-inspection";
const board = { sourceId: "a", manifestSha256: "a".repeat(64) };
const fixture = () => ({ contract: { name: "fabdesk.schematic-inspection", version: "4.0.0" }, scope: "complete-saved-hierarchy", ownership: "independent-source-snapshot", _board: { projectId: "p", ...board }, hierarchy: { aggregateRevision: "b".repeat(64), complete: false, counts: { components: 0, nets: 0, sheets: 1 }, sheets: [{ nativePath: "board.kicad_sch", hierarchyPath: "/", sha256: "c".repeat(64) }], issues: [{ kind: "missing", path: "child.kicad_sch", detail: "Missing native sheet" }], pagination: { returned: 1, total: 1, truncated: false } } });
test("captures source-bound complete or incomplete native facts even when the tool reports incomplete hierarchy", () => {
  const data = fixture(), snapshot = captureAssemblySchematicInspection({ result: { isError: true, json: data } }, "p", board);
  expect(snapshot.hierarchy.complete).toBe(false); expect(snapshot.hierarchy.issues[0]?.path).toBe("child.kicad_sch");
  data.hierarchy.complete = true;
  expect(captureAssemblySchematicInspection({ json: data }, "p", board).hierarchy.complete).toBe(true);
  expect(snapshot.hierarchy.complete).toBe(false);
});
test("rejects root responses, stale scope, non-owned inspections and malformed or escaping sheet paths", () => {
  for (const change of ["project", "source", "manifest", "root", "ownership", "path"] as const) {
    const data = fixture() as Record<string, any>;
    if (change === "project") data._board.projectId = "other";
    else if (change === "source") data._board.sourceId = "other";
    else if (change === "manifest") data._board.manifestSha256 = "d".repeat(64);
    else if (change === "root") delete data._board;
    else if (change === "ownership") delete data.ownership;
    else data.hierarchy.sheets[0].nativePath = "../other.kicad_sch";
    expect(() => captureAssemblySchematicInspection(data, "p", board)).toThrow();
  }
  expect(() => captureAssemblySchematicInspection({ text: "not a snapshot" }, "p", board)).toThrow();
});

test("synchronous HTTP inspection survives the generic tool runner without losing its structured result", async () => {
  const { CoreClient } = await import("./CoreClient"), { immediateToolResult } = await import("./tools");
  const client = new CoreClient({ baseUrl: "http://127.0.0.1:47831", token: "test", fetch: async (_url, init) => {
    expect(JSON.parse(String(init?.body))).toEqual({ project: "p", args: { board, detail: "summary" } });
    return Response.json({ ok: true, json: fixture(), text: "INCOMPLETE" });
  } });
  const result = immediateToolResult(await client.callTool("schematic_inspect", { projectId: "p", board, detail: "summary" }));
  expect(captureAssemblySchematicInspection(result, "p", board).hierarchy.complete).toBe(false);
  expect(immediateToolResult({ result: null })).toBe(null);
  expect(immediateToolResult({ result: { json: fixture() } })).toEqual({ json: fixture() });
});
