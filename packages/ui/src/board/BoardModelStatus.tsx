import { useRef } from "react";
import { BoardModelRevision, BOARD_MODEL_REVISION_PATH } from "@fabdesk/protocol";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { missingModelReferences } from "./ModelExportNotes";
import { useBoardModelRevision, useProjectJson } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { BoardModelExportDetails } from "./BoardModelExportDetails";

/** Source tracking is deliberately narrower than full model/fit verification. */
export function BoardModelStatus({ projectId, present, updating = false, floating = false }: { projectId: string; present: boolean; updating?: boolean; floating?: boolean }) {
  const panel = useRef<HTMLDetailsElement>(null);
  const revision = useBoardModelRevision(projectId, present);
  const raw = useProjectJson(projectId, BOARD_MODEL_REVISION_PATH);
  const parsed = BoardModelRevision.safeParse(raw.data);
  const verifiedReceipt = !revision.isFetching && !revision.isError && ["source-unchanged", "source-changed"].includes(revision.data ?? "") && parsed.success ? parsed.data : null;
  const missing = missingModelReferences(verifiedReceipt?.warnings ?? []);
  if (!present) return null;
  const state = revision.data;
  const label = updating ? "Updating 3D model…" : revision.isFetching || revision.isPending ? "Checking model source…" : revision.isError ? "Model source could not be checked" : state === "source-changed" ? "PCB changed · Review or update this model" : state === "artifact-changed" ? "Model file changed · Source unverified" : state === "source-unchanged" ? "PCB unchanged since model export" : state === "missing-source" ? "Model’s PCB source is missing" : state === "missing-artifact" ? "Saved model is missing" : "Saved model · Source unverified";
  return <details ref={panel} className={`fd-board-model-status${floating ? " fd-board-model-status-floating" : ""}`} data-warning={missing.length > 0 || ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(state ?? "")} aria-live="polite">
    <DisclosureSummary icon={missing.length ? "warning" : "cube"} label={!updating && state === "source-unchanged" && missing.length ? `3D model · ${missing.length} ${missing.length === 1 ? "model" : "models"} missing` : label} variant="compact" warning={missing.length > 0} />
    <div className="fd-board-model-status-body">
    <strong>{label}</strong>
    <span>External component models and physical fit are not verified.</span>
    <BoardModelExportDetails projectId={projectId} onAsk={() => { if (panel.current) panel.current.open = false; }} />
    {revision.isError && <Button size="sm" variant="ghost" onClick={() => void revision.refetch()}>Retry source check</Button>}
    </div>
  </details>;
}
