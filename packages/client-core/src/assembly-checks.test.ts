import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { inspectAssemblyPcbCheck } from "./assembly-checks";
import { sha256Blob } from "./pcb-preview-revision";
import { CoreHttpError } from "./CoreClient";
const board = { sourceId: "io", manifestSha256: "a".repeat(64) };
async function fixture() {
  const bytes = new Blob(["PCB"]), hash = await sha256Blob(bytes);
  const source = { id: "io", name: "I/O", location: "project", directory: "boards/io" };
  const data = ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: board.manifestSha256, editing: "explicit-source-tools", observedAt: "2026-10-28T00:00:00Z", assembly: { contract: "fabplane.assembly.v1", sources: [source], instances: [{ id: "left", name: "Left", sourceId: "io" }], connections: [] }, sources: [{ source, status: "available", pcbSha256: hash }] });
  const raw = { pcbRevision: { sha256: hash, bytes: bytes.size }, boardSource: { projectId: "p", ...board }, violations: [{ description: "Saved finding" }] };
  const paths: string[] = [];
  const client = { inspectBoardSources: async () => data, readFile: async (_p: string, path: string) => { paths.push(path); return JSON.stringify(raw); }, readFileBlob: async (_p: string, path: string) => { paths.push(path); return bytes; } };
  return { client, data, raw, paths, hash };
}
test("member report reads only its captured leaf and retains findings with matching source provenance", async () => {
  const f = await fixture(), result = await inspectAssemblyPcbCheck(f.client, "p", board);
  expect(result.state).toBe("source-unchanged"); expect(result.report).toEqual(f.raw); expect(result.sourceSha256).toBe(f.hash);
  expect(f.paths).toEqual(["boards/io/reports/drc.json", "boards/io/board.kicad_pcb"]);
  f.raw.pcbRevision.sha256 = "b".repeat(64);
  expect((await inspectAssemblyPcbCheck(f.client, "p", board)).state).toBe("source-changed");
});
test("missing, malformed, root and mismatched reports never supply member findings", async () => {
  const f = await fixture();
  const absent = { ...f.client, readFile: async () => { throw new CoreHttpError(404, "/files", "missing"); } };
  expect((await inspectAssemblyPcbCheck(absent, "p", board)).state).toBe("missing-report");
  for (const raw of ["bad", "{}", JSON.stringify({ ...f.raw, boardSource: undefined }), JSON.stringify({ ...f.raw, boardSource: { ...f.raw.boardSource, sourceId: "other" } }), JSON.stringify({ ...f.raw, boardSource: { ...f.raw.boardSource, manifestSha256: "b".repeat(64) } })]) {
    const result = await inspectAssemblyPcbCheck({ ...f.client, readFile: async () => raw }, "p", board);
    expect(result.state).toBe("scope-unverified"); expect(result.report).toBeNull();
  }
});
test("changed ownership/source during reads fails closed and caller mutation cannot retarget the captured selector", async () => {
  const f = await fixture(), requested = { ...board }; let inspections = 0;
  const result = await inspectAssemblyPcbCheck({ ...f.client, inspectBoardSources: async () => { inspections++; requested.sourceId = "other"; return f.data; } }, "p", requested);
  expect(result.board.sourceId).toBe("io"); expect(inspections).toBe(2);
  for (const change of ["membership", "source", "directory"] as const) {
    inspections = 0;
    await expect(inspectAssemblyPcbCheck({ ...f.client, inspectBoardSources: async () => {
      const data = structuredClone(f.data); if (++inspections > 1) {
        if (change === "membership") data.manifestSha256 = "b".repeat(64);
        if (change === "source") data.sources[0]!.pcbSha256 = "b".repeat(64);
        if (change === "directory" && data.sources[0]!.source.location === "project") data.sources[0]!.source.directory = "boards/other";
      } return data;
    } }, "p", board)).rejects.toThrow();
  }
  await expect(inspectAssemblyPcbCheck(f.client, "wrong-project", board)).rejects.toThrow("Select it again");
});
