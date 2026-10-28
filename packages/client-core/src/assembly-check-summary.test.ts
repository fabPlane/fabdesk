import { expect, test } from "bun:test";
import { ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";
import { assemblyCheckNeedsReview, assemblyCheckSummaryLabel, inspectAssemblyCheckSummaries } from "./assembly-check-summary";
function fixture() {
  const sources = ["a", "b", "c", "d", "e", "f"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` }));
  return ProjectBoardSources.parse({ projectId: "p", mode: "assembly", manifestSha256: "a".repeat(64), observedAt: "2026-10-28T00:00:00Z", editing: "explicit-source-tools", assembly: { contract: "fabplane.assembly.v1", sources, instances: [...sources.map(source => ({ id: source.id, sourceId: source.id, name: source.id })), { id: "shared", sourceId: "a", name: "Shared A" }], connections: [] }, sources: sources.map(source => ({ source, status: "available", pcbSha256: "1".repeat(64) })) });
}
const report = (sourceId: string, sourceSha = "1".repeat(64), findings = true) => new Blob([JSON.stringify({ boardSource: { projectId: "p", sourceId, manifestSha256: "a".repeat(64) }, pcbRevision: { sha256: sourceSha, bytes: 1 }, violations: findings ? [{ severity: "error", description: "Native finding" }] : [] })]);
test("summaries read once per source with bounded concurrency and one final ownership inspection, never PCB blobs", async () => {
  const data = fixture(), paths: string[] = []; let active = 0, peak = 0, inspections = 0;
  const summaries = await inspectAssemblyCheckSummaries({ inspectBoardSources: async () => { inspections++; return data; }, readFileBlob: async (_p, path) => {
    paths.push(path); active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    const source = path.split("/")[1]!;
    if (source === "d") throw new CoreHttpError(404, "/files", "missing");
    if (source === "f") return new Blob(["malformed"]);
    return report(source === "c" ? "wrong" : source, source === "b" ? "2".repeat(64) : "1".repeat(64), source !== "e");
  } }, "p", data);
  expect(paths).toHaveLength(6); expect(paths.every(path => path.endsWith("/reports/drc.json"))).toBe(true); expect(peak).toBeLessThanOrEqual(4); expect(inspections).toBe(1);
  expect(summaries.map(row => row.state)).toEqual(["source-unchanged", "source-changed", "scope-unverified", "missing-report", "source-unchanged", "scope-unverified"]);
  expect(summaries.filter(assemblyCheckNeedsReview).map(row => row.sourceId)).toEqual(["a", "b", "c", "f"]);
  expect(assemblyCheckSummaryLabel(summaries[0])).toBe("DRC · 1 finding");
  expect(assemblyCheckSummaryLabel(summaries[4])).toBe("PCB-only report · no listed findings");
});
test("ownership/source changes reject the whole summary and unavailable sources never supply report findings", async () => {
  const data = fixture(); data.sources[0]!.status = "missing"; const paths: string[] = [];
  const client = { readFileBlob: async (_p: string, path: string) => { paths.push(path); return report(path.split("/")[1]!); }, inspectBoardSources: async () => data };
  expect((await inspectAssemblyCheckSummaries(client, "p", data))[0]!.state).toBe("unavailable"); expect(paths).not.toContain("boards/a/reports/drc.json");
  for (const change of ["manifest", "source"] as const) await expect(inspectAssemblyCheckSummaries({ ...client, inspectBoardSources: async () => { const current = structuredClone(data); if (change === "manifest") current.manifestSha256 = "b".repeat(64); else current.sources[1]!.pcbSha256 = "2".repeat(64); return current; } }, "p", data)).rejects.toThrow("sources changed");
  await expect(inspectAssemblyCheckSummaries({ ...client, readFileBlob: async () => { throw new Error("offline"); } }, "p", data)).rejects.toThrow("offline");
});
