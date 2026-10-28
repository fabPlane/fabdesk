import { AssemblyPcbCheckReceipt, ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
import { normalizeReport } from "./check-findings";
export type AssemblyCheckSummary = { sourceId: string; state: "missing-report" | "scope-unverified" | "source-changed" | "source-unchanged" | "unavailable"; findingCount: number };
/** Read reports once per source with bounded concurrency; membership already supplies PCB hashes. Never hash every board once per member. */
export async function inspectAssemblyCheckSummaries(client: Pick<CoreClient, "readFileBlob" | "inspectBoardSources">, projectId: string, snapshot: ProjectBoardSources) {
  const data = ProjectBoardSources.parse(snapshot);
  if (data.projectId !== projectId || data.mode !== "assembly" || !data.manifestSha256) throw new Error("An explicit assembly declaration is required.");
  const summaries: AssemblyCheckSummary[] = new Array(data.sources.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, data.sources.length) }, async () => {
    for (;;) {
      const index = next++, row = data.sources[index]; if (!row) break;
      let state: AssemblyCheckSummary["state"] = "unavailable", findingCount = 0;
      if (row.status === "available" && row.source.location === "project" && row.pcbSha256) {
        const prefix = row.source.directory === "." ? "" : `${row.source.directory}/`;
        try {
          const blob = await client.readFileBlob(projectId, prefix + "reports/drc.json");
          let raw: unknown = null;
          if (blob.size <= 10 * 1024 * 1024) { try { raw = JSON.parse(await blob.text()); } catch { /* Unverified report; never current or clean. */ } }
          const receipt = AssemblyPcbCheckReceipt.safeParse(raw);
          if (!receipt.success || receipt.data.boardSource.projectId !== projectId || receipt.data.boardSource.sourceId !== row.source.id || receipt.data.boardSource.manifestSha256 !== data.manifestSha256) state = "scope-unverified";
          else { state = receipt.data.pcbRevision.sha256 === row.pcbSha256 ? "source-unchanged" : "source-changed"; findingCount = normalizeReport(raw, "drc").length; }
        } catch (error) { if (error instanceof CoreHttpError && error.status === 404) state = "missing-report"; else throw error; }
      }
      summaries[index] = { sourceId: row.source.id, state, findingCount };
    }
  }));
  const current = ProjectBoardSources.parse(await client.inspectBoardSources(projectId));
  if (current.projectId !== projectId || current.mode !== "assembly" || current.manifestSha256 !== data.manifestSha256 || current.sources.length !== data.sources.length || data.sources.some(before => {
    const after = current.sources.find(row => row.source.id === before.source.id);
    return !after || after.status !== before.status || after.pcbSha256 !== before.pcbSha256 || JSON.stringify(after.source) !== JSON.stringify(before.source);
  })) throw new Error("Board sources changed while reviewing checks. Recheck sources.");
  return summaries;
}
export function assemblyCheckSummaryLabel(summary: AssemblyCheckSummary | undefined) {
  if (!summary) return "Check status unavailable";
  return summary.state === "missing-report" ? "No saved PCB check" : summary.state === "scope-unverified" ? "DRC ownership unverified" : summary.state === "source-changed" ? "PCB changed since DRC" : summary.state === "unavailable" ? "Check source unavailable" : summary.findingCount ? `DRC · ${summary.findingCount} ${summary.findingCount === 1 ? "finding" : "findings"}` : "PCB-only report · no listed findings";
}
export function assemblyCheckNeedsReview(summary: AssemblyCheckSummary | undefined) {
  return !!summary && (summary.state === "source-changed" || summary.state === "scope-unverified" || summary.state === "source-unchanged" && summary.findingCount > 0);
}
