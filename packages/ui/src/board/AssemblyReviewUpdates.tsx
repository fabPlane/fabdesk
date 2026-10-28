import { useState } from "react";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblyCheckNeedsReview, assemblyCheckSummaryLabel, useAssemblyCheckSummaries, assemblyReviewRows, useAssemblyPreviewRevisions, useRunTool } from "@fabdesk/client-core";
import { Button, Spinner } from "../components/ui";
import { newChatDraftKey, useUiStore } from "../stores/ui";

export function AssemblyReviewUpdates({ projectId, data, checking, failed, onRetry }: { projectId: string; data: ProjectBoardSources; checking: boolean; failed: boolean; onRetry: () => void }) {
  const previews = useAssemblyPreviewRevisions(projectId, data.sources), update = useRunTool();
  const checks = useAssemblyCheckSummaries(projectId, data), checkById = new Map((checks.data ?? []).map(row => [row.sourceId, row]));
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
  return <div className="fd-review-updates" data-testid="assembly-review-updates">
    <header><h2>Review updates</h2><p>Review each board source once, including designs shared by several boards. Choose a preview to refresh; saved source files stay unchanged.</p><Button size="sm" variant="ghost" disabled={busy || checking} onClick={() => { onRetry(); void checks.refetch(); for (const preview of previews) if (preview.trackable) void preview.refetch(); }}>Recheck sources</Button></header>
    {failed && <p role="alert" className="fd-update-feedback">Project sources could not be refreshed. Retry before choosing a board or updating a preview.</p>}
    <div className="fd-update-table" role="table" aria-label="Assembly source review">
      <div className="fd-update-row fd-update-table-heading" role="row"><span role="columnheader">Board source</span><span role="columnheader">Preview and PCB checks</span><span role="columnheader">Next step</span></div>
      {rows.map(row => <div key={row.sourceId} className="fd-update-row" role="row" data-review-source={row.sourceId}>
        <div role="cell"><strong>{row.name}</strong><p>{row.note}</p>{row.instances.length > 1 && <p>{row.instances.map(instance => instance.name).join(" · ")}</p>}</div>
        <div role="cell" className="fd-assembly-review-status"><span data-warning={row.warning}>{unavailable ? failed ? "Source check unavailable" : "Checking project sources…" : row.status}</span><small data-warning={!checks.isFetching && !checks.isError && assemblyCheckNeedsReview(checkById.get(row.sourceId))}>{checking || checks.isFetching ? "Checking PCB reports…" : failed || checks.isError ? "PCB check status unavailable" : assemblyCheckSummaryLabel(checkById.get(row.sourceId))}</small></div>
        <div role="cell" className="fd-assembly-review-actions">
          {row.selection && <Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => { if (!active() || !row.selection) return; const ui = useUiStore.getState(); ui.setAssemblyBoard(row.selection); ui.setBoardTab("drc"); }}>PCB checks</Button>}
          {row.selection && <Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => { if (!active() || !row.selection) return; const ui = useUiStore.getState(); ui.setAssemblyBoard(row.selection); ui.setWorkspaceArea("boards"); }}>{row.instances.length > 1 ? "Inspect shared PCB" : "Inspect PCB"}</Button>}
          {row.board ? !row.previewCurrent && <Button size="sm" disabled={unavailable || busy || !!previews.find(preview => preview.sourceId === row.sourceId)?.isFetching} onClick={() => void refresh(row)}>{busy && updatingSource === row.sourceId ? "Updating preview…" : row.hasPreview ? "Update preview" : "Create preview"}</Button> : <Button size="sm" disabled={unavailable || busy} onClick={() => ask(row.sourceId, row.name)}>Resolve source</Button>}
        </div>
      </div>)}
    </div>
    {busy && <p role="status" className="fd-update-feedback"><Spinner />Updating one source preview; shared board instances use the same drawing.</p>}
    {update.state.error && <p role="alert" className="fd-update-feedback">{update.state.error}</p>}
    <section className="fd-update-sync"><div><h3>Checks and compatibility</h3><p>Preview freshness compares the saved PCB and drawing bytes. It does not verify electrical checks, schematic parity, cables or enclosure fit.</p><small>Run PCB-only DRC in Checks. Schematic parity, ERC and inter-board compatibility need separate review.</small></div><Button size="sm" variant="ghost" onClick={() => { if (active()) useUiStore.getState().setBoardTab("drc"); }}>Open board checks</Button></section>
  </div>;
}
