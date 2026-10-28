import { AssemblyBoardModelRevision, ProjectBoardSources } from "@fabdesk/protocol";
import { CoreHttpError, type CoreClient } from "./CoreClient";
export type AssemblyModelSummary = { sourceId: string; state: "missing-receipt" | "scope-unverified" | "source-changed" | "source-unchanged" | "unavailable" };
/** Read small receipts once per source. Source-only status never attests model bytes, existence, dependencies or fit. */
export async function inspectAssemblyModelSummaries(client: Pick<CoreClient, "readFileBlob" | "inspectBoardSources">, projectId: string, snapshot: ProjectBoardSources) {
  const data = ProjectBoardSources.parse(snapshot);
  if (data.projectId !== projectId || data.mode !== "assembly" || !data.manifestSha256) throw new Error("An explicit assembly declaration is required.");
  const summaries: AssemblyModelSummary[] = new Array(data.sources.length); let next = 0, stopped = false;
  const workers = await Promise.allSettled(Array.from({ length: Math.min(4, data.sources.length) }, async () => {
    for (;;) {
      if (stopped) break;
      const index = next++, row = data.sources[index]; if (!row) break;
      let state: AssemblyModelSummary["state"] = "unavailable";
      if (row.status === "available" && row.source.location === "project" && row.pcbSha256) {
        const prefix = row.source.directory === "." ? "" : `${row.source.directory}/`;
        try {
          const blob = await client.readFileBlob(projectId, prefix + "renders/board.glb.revision.json");
          let raw: unknown = null;
          if (blob.size <= 64 * 1024) { try { raw = JSON.parse(await blob.text()); } catch { /* Unverified receipt; never attest a model. */ } }
          const receipt = AssemblyBoardModelRevision.safeParse(raw);
          if (!receipt.success || receipt.data.boardSource.projectId !== projectId || receipt.data.boardSource.sourceId !== row.source.id || receipt.data.boardSource.manifestSha256 !== data.manifestSha256) state = "scope-unverified";
          else { state = receipt.data.sourceSha256 === row.pcbSha256 ? "source-unchanged" : "source-changed"; }
        } catch (error) { if (error instanceof CoreHttpError && error.status === 404) state = "missing-receipt"; else { stopped = true; throw error; } }
      }
      summaries[index] = { sourceId: row.source.id, state };
    }
  }));
  const failure = workers.find(worker => worker.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const current = ProjectBoardSources.parse(await client.inspectBoardSources(projectId));
  if (current.projectId !== projectId || current.mode !== "assembly" || current.manifestSha256 !== data.manifestSha256 || current.sources.length !== data.sources.length || data.sources.some(before => {
    const after = current.sources.find(row => row.source.id === before.source.id);
    return !after || after.status !== before.status || after.pcbSha256 !== before.pcbSha256 || JSON.stringify(after.source) !== JSON.stringify(before.source);
  })) throw new Error("Board sources changed while reviewing model receipts. Recheck sources.");
  return summaries;
}
export function assemblyModelSummaryLabel(summary: AssemblyModelSummary | undefined) {
  if (!summary) return "Model source status unavailable";
  return summary.state === "missing-receipt" ? "No saved model receipt" : summary.state === "scope-unverified" ? "3D model ownership unverified" : summary.state === "source-changed" ? "PCB changed since 3D export" : summary.state === "unavailable" ? "Model source unavailable" : "PCB unchanged since 3D export · model not inspected";
}
export function assemblyModelNeedsReview(summary: AssemblyModelSummary | undefined) {
  return !!summary && (summary.state === "source-changed" || summary.state === "scope-unverified");
}
