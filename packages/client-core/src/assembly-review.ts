import type { ProjectBoardSources } from "@fabdesk/protocol";
import { captureAssemblySelection } from "./assembly-scene";
import type { PcbPreviewState } from "./pcb-preview-revision";

type Preview = { data?: PcbPreviewState | undefined; isFetching: boolean; isError: boolean };
/** One row per declared source, even when several physical boards share it. Preview provenance is not an electrical check. */
export function assemblyReviewRows(data: ProjectBoardSources, previews: ReadonlyMap<string, Preview>, attentionSources: ReadonlySet<string> = new Set()) {
  if (data.mode !== "assembly" || !data.assembly) return [];
  return data.sources.map(row => {
    const instances = data.assembly!.instances.filter(instance => instance.sourceId === row.source.id);
    const preview = previews.get(row.source.id), available = row.status === "available" && row.source.location === "project";
    const state = preview?.data;
    const status = !available ? row.status === "unresolved" ? "Source not imported" : row.status === "blocked" ? "Source needs review" : "Source missing"
      : preview?.isFetching ? "Checking preview…" : preview?.isError ? "Preview check unavailable" : !row.previewPath ? "No saved preview"
      : state === "matches-source" ? "Preview matches saved PCB" : state === "source-changed" ? "PCB changed since preview" : state === "artifact-changed" ? "Preview changed · unverified"
      : state === "missing-source" ? "PCB source missing" : state === "missing-artifact" ? "Preview file missing" : "Saved preview · unverified";
    return { sourceId: row.source.id, name: row.source.name, instances, status,
      warning: !available || ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(state ?? ""),
      note: row.reason ?? (instances.length > 1 ? `Shared source · ${instances.length} boards` : instances.length === 1 ? instances[0]!.name === row.source.name ? "1 board" : instances[0]!.name : "No board instance uses this source"),
      board: available && data.manifestSha256 ? { sourceId: row.source.id, manifestSha256: data.manifestSha256 } : null,
      selection: available && instances[0] ? captureAssemblySelection(data, instances[0].id) : null,
      hasPreview: !!row.previewPath,
      previewCurrent: available && !!row.previewPath && !preview?.isFetching && !preview?.isError && state === "matches-source",
    };
  }).sort((a, b) => Number(b.warning || attentionSources.has(b.sourceId)) - Number(a.warning || attentionSources.has(a.sourceId)));
}
