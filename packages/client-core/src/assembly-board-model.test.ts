import { ProjectBoardSources } from "@fabdesk/protocol";
import { expect,test } from "bun:test";
import { inspectAssemblyBoardModel } from "./assembly-board-model";
import { CoreHttpError } from "./CoreClient";
import { sha256Blob } from "./pcb-preview-revision";
async function fixture(pcbText = "PCB") {
  const pcb = new Blob([pcbText]), model = new Blob(["GLB"]), hash = await sha256Blob(pcb);
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" }, board = { sourceId: "io", manifestSha256: "a".repeat(64) };
  const data = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: board.manifestSha256, editing: "explicit-source-tools", observedAt: "2026-10-28T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left", sourceId: "io" }], connections: [] }, sources: [{ source, status: "available", pcbSha256: hash }] });
  const receipt = { contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb", sourceSha256: hash, artifactSha256: await sha256Blob(model), dependencies: "unverified", generatedAt: "2026-10-28T00:00:00Z", boardSource: { projectId: "p", ...board }, warnings: ["Component model unavailable"] };
  const paths: string[] = [];
  const client = { inspectBoardSources: async () => data, readFile: async (_p: string, path: string) => { paths.push(path); return JSON.stringify(receipt); }, readFileBlob: async (_p: string, path: string) => { paths.push(path); if (path === "boards/io/board.kicad_pcb") return pcb; if (path === "boards/io/renders/board.glb") return model; throw Error("Root or other source was read"); } };
  return { client, data, board, receipt, model, paths };
}
test("member model inspection returns exactly the inspected source-bound bytes, warning notes and leaf path", async () => {
  const f = await fixture(), result = await inspectAssemblyBoardModel(f.client, "p", f.board);
  expect(result.state).toBe("source-unchanged"); expect(result.model).toBe(f.model); expect(result.path).toBe("boards/io/renders/board.glb");
  expect(result.warnings).toEqual(["Component model unavailable"]); expect(f.paths.filter(path => path.endsWith("board.glb"))).toHaveLength(1);
  f.receipt.sourceSha256 = "b".repeat(64); expect((await inspectAssemblyBoardModel(f.client, "p", f.board)).state).toBe("source-changed");
  f.receipt.artifactSha256 = "c".repeat(64); expect((await inspectAssemblyBoardModel(f.client, "p", f.board)).state).toBe("artifact-changed");
});
test("an assembly member with stock LEDs refreshes its legacy export once", async () => {
  const f = await fixture('(model "${KICAD9_3DMODEL_DIR}/LED_THT.3dshapes/LED_D5.0mm.step")');
  expect((await inspectAssemblyBoardModel(f.client, "p", f.board)).state).toBe("source-changed");
  const upgraded = { ...f.client, readFile: async () => JSON.stringify({ ...f.receipt, ledLensVersion: 1 }) };
  expect((await inspectAssemblyBoardModel(upgraded, "p", f.board)).state).toBe("source-unchanged");
});
test("root/other-source/older-declaration receipts remain unverified and missing models never fall back", async () => {
  const f = await fixture();
  for (const raw of [{ ...f.receipt, boardSource: undefined }, { ...f.receipt, boardSource: { ...f.receipt.boardSource, sourceId: "other" } }, { ...f.receipt, boardSource: { ...f.receipt.boardSource, manifestSha256: "b".repeat(64) } }]) {
    const result = await inspectAssemblyBoardModel({ ...f.client, readFile: async () => JSON.stringify(raw) }, "p", f.board);
    expect(result.state).toBe("scope-unverified"); expect(result.warnings).toEqual([]);
  }
  const missing = await inspectAssemblyBoardModel({ ...f.client, readFileBlob: async (p, path) => { if (path.endsWith("board.glb")) throw new CoreHttpError(404, path, "missing"); return f.client.readFileBlob(p, path); } }, "p", f.board);
  expect(missing.state).toBe("missing-model"); expect(missing.model).toBeNull();
});

test("a member model becomes stale when its model library changes without a PCB edit", async () => {
  const f = await fixture();
  const receipt = { ...f.receipt, dependencySnapshot: { revision: "a".repeat(64), files: [], unresolved: [] } };
  const client = { ...f.client, readFile: async () => JSON.stringify(receipt),
    inspectOutputDependencies: async (_projectId: string, directory: string) => {
      expect(directory).toBe("boards/io");
      return { revision: "b".repeat(64) };
    } };
  expect((await inspectAssemblyBoardModel(client, "p", f.board)).state).toBe("source-changed");
});
test("changed ownership/source during model reads fails closed and caller mutation cannot retarget", async () => {
  const f = await fixture(), requested = { ...f.board }; let inspections = 0;
  const result = await inspectAssemblyBoardModel({ ...f.client, inspectBoardSources: async () => { requested.sourceId = "other"; return f.data; } }, "p", requested);
  expect(result.board.sourceId).toBe("io");
  await expect(inspectAssemblyBoardModel({ ...f.client, inspectBoardSources: async () => { const data = structuredClone(f.data); if (++inspections > 1) data.manifestSha256 = "b".repeat(64); return data; } }, "p", f.board)).rejects.toThrow("Select it again");
  await expect(inspectAssemblyBoardModel({ ...f.client, readFileBlob: async (p, path) => path.endsWith("board.kicad_pcb") ? new Blob(["changed"]) : f.client.readFileBlob(p, path) }, "p", f.board)).rejects.toThrow("PCB changed");
});
