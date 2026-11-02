import { useBoardModelRevision } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { BoardModelExportDetails } from "./BoardModelExportDetails";

/** Source tracking is deliberately narrower than full model/fit verification. */
export function BoardModelStatus({ projectId, present, updating = false, floating = false }: { projectId: string; present: boolean; updating?: boolean; floating?: boolean }) {
  const revision = useBoardModelRevision(projectId, present);
  if (!present) return null;
  const state = revision.data;
  const label = updating ? "Updating 3D model…" : revision.isFetching || revision.isPending ? "Checking model source…" : revision.isError ? "Model source could not be checked" : state === "source-changed" ? "PCB changed · Review or update this model" : state === "artifact-changed" ? "Model file changed · Source unverified" : state === "source-unchanged" ? "PCB unchanged since model export" : state === "missing-source" ? "Model’s PCB source is missing" : state === "missing-artifact" ? "Saved model is missing" : "Saved model · Source unverified";
  return <div className={`fd-board-model-status${floating ? " fd-board-model-status-floating" : ""}`} data-warning={["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(state ?? "")} aria-live="polite">
    <strong>{label}</strong>
    <span>External component models and physical fit are not verified.</span>
    <BoardModelExportDetails projectId={projectId} />
    {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry source check</Button>}
  </div>;
}
