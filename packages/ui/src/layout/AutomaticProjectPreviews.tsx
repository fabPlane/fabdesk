import { useBoardSources, useLivePreview, type PreviewScope } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";

function PrepareSource(props: PreviewScope) {
  useLivePreview("pcb", props);
  useLivePreview("schematic", props);
  useLivePreview("layers", props);
  useLivePreview("model", props);
  return null;
}

/** Warm the active project's owned native sources even while another tab is open. */
export function AutomaticProjectPreviews() {
  const projectId = useUiStore(s => s.activeProjectId);
  const sources = useBoardSources(projectId);
  if (!projectId || sources.isError || !sources.data) return null;
  if (sources.data.mode === "single") return <PrepareSource key={projectId} projectId={projectId} />;
  const manifestSha256 = sources.data.manifestSha256;
  if (!manifestSha256) return null;
  return <>{sources.data.sources.map(row => row.status === "available" && row.source.location === "project" ?
    <PrepareSource key={`${projectId}/${row.source.id}/${manifestSha256}`} projectId={projectId} directory={row.source.directory} board={{ sourceId: row.source.id, manifestSha256 }} /> : null)}</>;
}
