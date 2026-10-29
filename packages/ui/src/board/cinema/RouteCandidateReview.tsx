import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteReview, useRunTool } from "@fabdesk/client-core";
import { askAboutSurface, useAssistantSurface } from "../../chat/useAssistantSurface";
import { Button, Dialog, LoadError, Spinner } from "../../components/ui";
import { ErrorNotice } from "../../components/ErrorNotice";
import { Icon } from "../../components/Icon";
import { useUiStore } from "../../stores/ui";

/** Existing revision-bound route_apply, exposed as an explicit review step after playback. */
export function RouteCandidateReview({ projectId, runId, enabled, onBusyChange, onChanged }: { projectId: string; runId: string; enabled: boolean; onBusyChange: (busy: boolean) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false), [working, setWorking] = useState(false), workingRef = useRef(false);
  const review = useRouteReview(projectId, runId, enabled && open), apply = useRunTool(), qc = useQueryClient();
  useEffect(() => { onBusyChange(working); return () => onBusyChange(false); }, [working, onBusyChange]);
  useAssistantSurface(open ? { projectId, label: "Routing / Candidate review", priority: 40, details: JSON.stringify({ runId, candidate: review.data ?? null, status: "Recorded route candidate; applying is separate from electrical validation." }) } : null);
  const applyCandidate = async () => {
    if (workingRef.current || !enabled || useUiStore.getState().activeProjectId !== projectId) return;
    workingRef.current = true; setWorking(true);
    try {
      const latest = await review.refetch();
      if (latest.isError || !latest.data?.canApply || useUiStore.getState().activeProjectId !== projectId) return;
      const result = await apply.run("route_apply", { projectId, runId, expectedPcbRevision: latest.data.expectedPcbRevision });
      await review.refetch();
      if (result.status === "done") {
        for (const key of [["project", projectId], ["file", projectId], ["pcb-preview-revision", projectId], ["board-model-revision", projectId], ["pcb-check-revision", projectId]]) void qc.invalidateQueries({ queryKey: key });
        onChanged();
      }
    } finally { workingRef.current = false; setWorking(false); }
  };
  const data = review.data;
  return <><Button size="sm" disabled={!enabled || working} onClick={() => setOpen(true)}><Icon name="route" width={15} height={15} />Review candidate</Button>
    <Dialog open={open} onClose={() => { if (!workingRef.current) setOpen(false); }} title="Review routing candidate">
      {review.isPending ? <Spinner /> : review.isError ? <LoadError title="Could not inspect the saved routing candidate" onRetry={() => void review.refetch()} /> : data && <div className="space-y-4">
        <div><strong>{data.applied ? "Candidate applied" : data.resultState === "complete" ? "All requested connections routed" : data.resultState === "partial" ? "Partial routing candidate" : "Recorded routing result"}</strong><p className="mt-1 text-sm text-muted">{data.reason}</p></div>
        <pre className="whitespace-pre-wrap rounded-lg border border-border bg-panel-2 p-3 text-xs">{data.quality}</pre>
        {!!data.openNets.length && <p className="text-sm text-warning">Unrouted nets: {data.openNets.join(", ")}. Applying this candidate does not complete routing.</p>}
        {data.warnings.map((warning, index) => <p key={index} className="text-sm text-warning">{warning.text}</p>)}
        <p className="text-xs text-muted">Review the recorded playback and candidate source. Apply replaces the saved PCB after checking its starting revision and candidate identity. Drawings, models and checks may then need updating. A routing result does not establish electrical parity or manufacturing readiness.</p>
        <div className="flex flex-wrap gap-2">
          {data.canApply && <Button size="sm" variant="primary" disabled={!enabled || working || review.isFetching} onClick={() => void applyCandidate()}>{working ? "Applying…" : "Apply candidate"}</Button>}
          {data.applied && <Button size="sm" disabled={working} onClick={() => { setOpen(false); useUiStore.getState().setBoardTab("pcb"); }}>Open saved PCB</Button>}
          {data.available && <Button size="sm" variant="ghost" disabled={working} onClick={() => { setOpen(false); useUiStore.getState().openProjectFile(data.candidatePath); }}>Open candidate source</Button>}
          <Button size="sm" variant="ghost" disabled={working} onClick={() => {
            askAboutSurface({ projectId, label: "Routing / Candidate review", priority: 40, details: JSON.stringify({ runId, review: data }) }, "Review this routing candidate, its remaining connections and quality warnings. Explain whether applying it would help. Inspect the latest PCB first and propose the next action before changing it."); setOpen(false);
          }}><Icon name="sparkles" width={15} height={15} />Ask fabPlane</Button>
          <Button size="sm" variant="ghost" disabled={working} onClick={() => setOpen(false)}>{data.applied ? "Close" : "Keep saved PCB"}</Button>
        </div>
        {!enabled && <p role="status" className="text-xs text-warning">Finish the active board operation before applying this candidate.</p>}
        {apply.state.error && <ErrorNotice error={apply.state.error} />}
      </div>}
    </Dialog>
  </>;
}
