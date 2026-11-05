import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";
import { assemblyModelNeedsReview, assemblyModelSummaryLabel, inspectAssemblyModelSummaries } from "./assembly-model-summary";
function fixture() {
  const sources = ["a", "b", "c", "d", "e", "f"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` }));
  return ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: "a".repeat(64), observedAt: "2026-10-28T00:00:00Z", editing: "explicit-source-tools", assembly: { contract: "fabplane.assembly.v1", sources, instances: [...sources.map(source => ({ id: source.id, sourceId: source.id, name: source.id })), { id: "shared", sourceId: "a", name: "Shared A" }], connections: [] }, sources: sources.map(source => ({ source, status: "available", pcbSha256: "1".repeat(64) })) });
}
const report = (sourceId: string, sourceSha = "1".repeat(64)) => new Blob([JSON.stringify({ contract: "fabplane.board-model-revision.v1", source: "board.kicad_pcb", artifact: "renders/board.glb", sourceSha256: sourceSha, artifactSha256: "3".repeat(64), generatedAt: "2026-10-28T00:00:00Z", dependencies: "unverified", boardSource: { projectId: "p", sourceId, manifestSha256: "a".repeat(64) } })]);
test("summaries read once per source with bounded concurrency and one final ownership inspection, never PCB blobs", async () => {
  const data = fixture(), paths: string[] = []; let active = 0, peak = 0, inspections = 0;
  const summaries = await inspectAssemblyModelSummaries({ inspectBoardSources: async () => { inspections++; return data; }, readFileBlob: async (_p, path) => {
    paths.push(path); active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const source = path.split("/")[1]!;
    if (source === "d") throw new CoreHttpError(404, "/files", "missing");
    if (source === "f") return new Blob(["malformed"]);
    return report(source === "c" ? "wrong" : source, source === "b" ? "2".repeat(64) : "1".repeat(64));
  } }, "p", data);
  expect(paths).toHaveLength(6); expect(paths.every(path => path.endsWith("/renders/board.glb.revision.json"))).toBe(true); expect(peak).toBeLessThanOrEqual(4); expect(inspections).toBe(1);
  expect(summaries.map(row => row.state)).toEqual(["source-unchanged", "source-changed", "scope-unverified", "missing-receipt", "source-unchanged", "scope-unverified"]);
  expect(summaries.filter(assemblyModelNeedsReview).map(row => row.sourceId)).toEqual(["b", "c", "f"]);
  expect(assemblyModelSummaryLabel(summaries[0])).toBe("PCB unchanged since 3D export · model not inspected");
  expect(assemblyModelSummaryLabel(summaries[4])).toBe("PCB unchanged since 3D export · model not inspected");
});
test("ownership/source changes reject the whole summary and unavailable sources never supply report findings", async () => {
  const data = fixture(); data.sources[0]!.status = "missing"; const paths: string[] = [];
  const client = { readFileBlob: async (_p: string, path: string) => { paths.push(path); return report(path.split("/")[1]!); }, inspectBoardSources: async () => data };
  expect((await inspectAssemblyModelSummaries(client, "p", data))[0]!.state).toBe("unavailable"); expect(paths).not.toContain("boards/a/renders/board.glb.revision.json");
  for (const change of ["manifest", "source"] as const) await expect(inspectAssemblyModelSummaries({ ...client, inspectBoardSources: async () => { const current = structuredClone(data); if (change === "manifest") current.manifestSha256 = "b".repeat(64); else current.sources[1]!.pcbSha256 = "2".repeat(64); return current; } }, "p", data)).rejects.toThrow("sources changed");
  await expect(inspectAssemblyModelSummaries({ ...client, readFileBlob: async () => { throw new Error("offline"); } }, "p", data)).rejects.toThrow("offline");
});

test("transport failure settles started reads before rejecting and stops further batches", async () => {
  const data = fixture(); let active = 0, calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const query = inspectAssemblyModelSummaries({ inspectBoardSources: async () => data, readFileBlob: async (_p, path) => {
    calls++; active++;
    try { if (path.includes("/a/")) throw new Error("offline"); await gate; return report(path.split("/")[1]!); }
    finally { active--; }
  } }, "p", data);
  let rejected = false; void query.catch(() => { rejected = true; });
  await new Promise(resolve => setTimeout(resolve, 1));
  expect(rejected).toBe(false); expect(active).toBe(3);
  release(); await expect(query).rejects.toThrow("offline"); expect(active).toBe(0); expect(calls).toBe(4);
});

test("old root receipts and oversized receipts cannot attest member model ownership", async () => {
  const data = fixture();
  for (const value of [new Blob([" ".repeat(65537)]), new Blob([JSON.stringify({ ...JSON.parse(await report("a").text()), boardSource: undefined })])]) {
    const rows = await inspectAssemblyModelSummaries({ inspectBoardSources: async () => data, readFileBlob: async () => value }, "p", data);
    expect(rows.every(row => row.state === "scope-unverified")).toBe(true);
  }
  await expect(inspectAssemblyModelSummaries({ inspectBoardSources: async () => data, readFileBlob: async () => report("a") }, "wrong", data)).rejects.toThrow("explicit assembly");
  const changed = structuredClone(data); const source = changed.sources[0]!.source; if (source.location === "project") source.directory = "boards/moved";
  await expect(inspectAssemblyModelSummaries({ inspectBoardSources: async () => changed, readFileBlob: async () => report("a") }, "p", data)).rejects.toThrow("sources changed");
});
