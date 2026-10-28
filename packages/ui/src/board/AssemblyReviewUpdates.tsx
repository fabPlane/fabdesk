import { useState } from "react";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { restoreAssemblySelection, assemblyModelNeedsReview, assemblyModelSummaryLabel, useAssemblyModelSummaries, assemblyCheckNeedsReview, assemblyCheckSummaryLabel, useAssemblyCheckSummaries, assemblyReviewRows, useAssemblyPreviewRevisions, useRunTool } from "@fabdesk/client-core";
import { Icon } from "../components/Icon";
import { Button, Spinner } from "../components/ui";
import { newChatDraftKey, useUiStore } from "../stores/ui";

export function AssemblyReviewUpdates({ projectId, data, checking, failed, onRetry }: { projectId: string; data: ProjectBoardSources; checking: boolean; failed: boolean; onRetry: () => void }) {
  const previews = useAssemblyPreviewRevisions(projectId, data.sources), update = useRunTool();
  const checks = useAssemblyCheckSummaries(projectId, data), checkById = new Map((checks.data ?? []).map(row => [row.sourceId, row]));
  const models = useAssemblyModelSummaries(projectId, data), modelById = new Map((models.data ?? []).map(row => [row.sourceId, row]));
  const [updatingSource, setUpdatingSource] = useState<string | null>(null);
  const rows = assemblyReviewRows(data, new Map(previews.map(preview => [preview.sourceId, preview])));
  const busy = update.state.status === "running", unavailable = checking || failed;
  const active = () => useUiStore.getState().activeProjectId === projectId;
  const ask = (sourceId: string, name: string) => {
    const ui = useUiStore.getState(); if (!active() || unavailable) return;
    const key = ui.activeThreadId ?? newChatDraftKey(projectId), previous = ui.drafts[key] ?? "";
    const prompt = `Review source ${JSON.stringify(sourceId)} (${JSON.stringify(name)}) in this assembly. Identify missing files, revision differences and affected boards before proposing any changes. Do not claim compatibility or synchronize files without reviewing the native sources.`;
    ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt); ui.focusComposer();
  };
  const refresh = async (row: typeof rows[number]) => {
    if (!row.board || busy || unavailable || !active()) return;
    setUpdatingSource(row.sourceId);
    await update.run("render_pcb_svg", { projectId, board: { ...row.board } });
    // The source/preview hashes establish the visible result, not a tool's generic success message.
    if (active()) { onRetry(); void previews.find(preview => preview.sourceId === row.sourceId)?.refetch(); }
  };
  const openSource = (row: typeof rows[number], tab: "pcb" | "drc" | "3d") => {
    if (!active() || unavailable || busy || !row.selection) return;
    const ui = useUiStore.getState();
    const previous = restoreAssemblySelection(data, ui.assemblyBoardByProject[projectId]);
    ui.setAssemblyBoard(previous?.sourceId === row.sourceId ? previous : row.selection); ui.setBoardTab(tab);
  };
  return <div className="fd-review-updates" data-testid="assembly-review-updates">
    <header><h2>Choose what to update</h2><p>Choose which previews to refresh. Shared boards use one source. Checks and physical fit stay separate.</p><Button size="sm" variant="ghost" disabled={busy || checking} onClick={() => { onRetry(); void checks.refetch(); void models.refetch(); for (const preview of previews) if (preview.trackable) void preview.refetch(); }}>Recheck sources</Button></header>
    {failed && <p role="alert" className="fd-update-feedback">Project sources could not be refreshed. Retry before choosing a board or updating a preview.</p>}
    <div className="fd-update-table" role="table" aria-label="Assembly source review">
      <div className="fd-update-row fd-update-table-heading" role="row"><span role="columnheader">Board source</span><span role="columnheader">Source status</span><span role="columnheader">Next step</span></div>
      {rows.map(row => {
        const checkWarning = !unavailable && !checks.isFetching && !checks.isError && assemblyCheckNeedsReview(checkById.get(row.sourceId));
        const modelWarning = !unavailable && !models.isFetching && !models.isError && assemblyModelNeedsReview(modelById.get(row.sourceId));
        return <div key={row.sourceId} className="fd-update-row" role="row" data-review-source={row.sourceId}>
          <div role="cell"><strong className="fd-review-source-name"><Icon name="pcb" width={20} height={20} />{row.name}</strong><p>{row.note}</p>{row.instances.length > 1 && <p>{row.instances.map(instance => instance.name).join(" · ")}</p>}</div>
          <div role="cell" className="fd-assembly-review-status">
            <span data-warning={!unavailable && row.warning}>{unavailable ? failed ? "Source check unavailable" : "Checking project sources…" : row.status}</span>
            {checkWarning && <small data-warning>{assemblyCheckSummaryLabel(checkById.get(row.sourceId))}</small>}
            {modelWarning && <small data-warning>{assemblyModelSummaryLabel(modelById.get(row.sourceId))}</small>}
            <details className="fd-review-source-details">
              <summary aria-label={`Checks and model for ${row.name}`}>Checks and model</summary>
              <div>
                <p>{checking || checks.isFetching ? "Checking PCB reports…" : failed || checks.isError ? "PCB check status unavailable" : assemblyCheckSummaryLabel(checkById.get(row.sourceId))}</p>
                <p>{checking || models.isFetching ? "Checking model receipts…" : failed || models.isError ? "Model source status unavailable" : assemblyModelSummaryLabel(modelById.get(row.sourceId))}</p>
                {row.selection && <div className="fd-review-detail-actions">
                  <Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => openSource(row, "drc")}>PCB checks</Button>
                  <Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => openSource(row, "3d")}>Review 3D model</Button>
                  {!row.previewCurrent && <Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => openSource(row, "pcb")}>Open board</Button>}
                </div>}
              </div>
            </details>
          </div>
          <div role="cell" className="fd-assembly-review-actions">
            {row.board ? !row.previewCurrent ? <Button size="sm" disabled={unavailable || busy || !!previews.find(preview => preview.sourceId === row.sourceId)?.isFetching} onClick={() => void refresh(row)}>{busy && updatingSource === row.sourceId ? "Updating preview…" : row.hasPreview ? "Update preview" : "Create preview"}</Button> : row.selection && <Button size="sm" variant="ghost" onClick={() => openSource(row, "pcb")} disabled={unavailable || busy}>Open board</Button> : <Button size="sm" disabled={unavailable || busy} onClick={() => ask(row.sourceId, row.name)}>Resolve source</Button>}
          </div>
        </div>;
      })}

    </div>
    {busy && <p role="status" className="fd-update-feedback"><Spinner />Updating one source preview; shared board instances use the same drawing.</p>}
    {update.state.error && <p role="alert" className="fd-update-feedback">{update.state.error}</p>}
    <details className="fd-review-explanation"><summary>How these source checks work</summary><section className="fd-update-sync"><div><h3>Checks and compatibility</h3><p>Preview freshness compares the saved PCB and drawing bytes. Model receipts compare the export’s PCB source; open a model to inspect its bytes. Neither verifies electrical checks, schematic parity, model dependencies, cables or enclosure fit.</p><small>Run PCB-only DRC in Checks. Schematic parity, ERC and inter-board compatibility need separate review.</small></div><Button size="sm" variant="ghost" onClick={() => { if (active()) useUiStore.getState().setBoardTab("drc"); }}>Open board checks</Button></section></details>
  </div>;
}
