import { KeepSavedOutput } from "./KeepSavedOutput";
import { videoInputLabel } from "./VideoSourceStatus";
import { CoreHttpError, useBoardSources, useProject, useProjectOrder, usePcbPreviewRevision, useBoardModelRevision, useEnclosureSourceRevision, usePcbCheckRevision, useRunTool, useVideoInputRevision, videoInputsNeedReview } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { AssemblyReviewUpdates } from "./AssemblyReviewUpdates";
import { newChatDraftKey, useUiStore } from "../stores/ui";

type Row = { item: string; status: string; note: string; warning: boolean; action: string; keep?: { kind: "pcb-preview" | "board-model"; eligible: boolean }; disabled?: boolean; onClick: () => void };

/** A review of known dependencies, not a claim that every project artifact is synchronized. */
export function ReviewUpdates() {
  const projectId = useUiStore(state => state.activeProjectId), project = useProject(projectId), sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.isError && !sources.data && !(sources.error instanceof CoreHttpError && sources.error.status === 404 && project.data && !project.data.files.some(file => file.path === "fabplane.assembly.json"))) return <LoadError title="Could not inspect project board sources" onRetry={() => { void sources.refetch(); void project.refetch(); }} />;
  if (sources.data?.mode === "assembly") return <AssemblyReviewUpdates projectId={projectId} data={sources.data} checking={sources.isFetching} failed={sources.isError} onRetry={() => { void sources.refetch(); }} />;
  return <SingleBoardUpdates scopeReady={!sources.isFetching && !sources.isError && sources.data?.mode === "single"} />;
}

function SingleBoardUpdates({ scopeReady }: { scopeReady: boolean }) {
  const projectId = useUiStore(state => state.activeProjectId), project = useProject(projectId), update = useRunTool();
  const files = project.data?.files ?? [], has = (path: string) => files.some(file => file.path === path);
  const pcb = has("board.kicad_pcb"), schematic = has("board.kicad_sch");
  const preview = usePcbPreviewRevision(projectId, has("renders/pcb.svg"));
  const model = useBoardModelRevision(projectId, has("renders/board.glb"));
  const enclosure = useEnclosureSourceRevision(projectId, has("enclosure.json"));
  const checks = usePcbCheckRevision(projectId, has("reports/drc.json"));
  const readiness = useProjectOrder(projectId);
  const videoPath = ["mp4", "webm", "gif"].map(ext => `exports/product-video.${ext}`).find(has);
  const video = useVideoInputRevision(projectId, videoPath);
  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load project updates" onRetry={() => void project.refetch()} />;
  if (project.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const open = (tab: "pcb" | "cad" | "drc" | "renders") => useUiStore.getState().setBoardTab(tab);
  const retry = (queries: Array<{ refetch: () => unknown }>) => { for (const query of queries) void query.refetch(); };
  const busy = update.state.status === "running";
  const refresh = (kind: "render_pcb_svg" | "glb") => {
    if (!scopeReady || busy || useUiStore.getState().activeProjectId !== projectId) return;
    void update.run(kind, { projectId });
  };
  const rows: Row[] = [
    ...(videoPath ? [{ item: "Product video", status: video.isFetching ? "Checking video inputs…" : video.isError ? "Could not check video inputs" : videoInputLabel(video.data), warning: videoInputsNeedReview(video.data), note: "Checks recorded model inputs and video bytes, including the PCB source of a tracked board model. Captions, newly added scene content and external model dependencies need separate review. Your saved video stays until you choose Make video.", action: "Review video", onClick: () => { if (useUiStore.getState().activeProjectId === projectId) { useUiStore.getState().setWorkspaceArea("outputs"); useUiStore.getState().setWorkspaceTab("3d"); } } }] : []),
    { item: "PCB preview", keep: { kind: "pcb-preview", eligible: scopeReady && !busy && !preview.isFetching && !preview.isError && preview.data === "source-changed" }, status: !has("renders/pcb.svg") ? "Not generated" : preview.isFetching ? "Checking source…" : preview.isError ? "Could not check source" : preview.data === "source-changed" ? "PCB source changed" : preview.data === "artifact-changed" ? "Preview file changed" : preview.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified", warning: ["source-changed", "artifact-changed"].includes(preview.data ?? ""), note: "Updates the drawing from the saved PCB. Electrical checks stay separate.", action: preview.data === "matches-source" && !preview.isError && !preview.isFetching ? "Open board" : has("renders/pcb.svg") ? "Update preview" : "Create preview", disabled: !pcb || !scopeReady || busy || preview.isFetching, onClick: () => { if (useUiStore.getState().activeProjectId !== projectId) return; if (preview.data === "matches-source" && !preview.isError) open("pcb"); else refresh("render_pcb_svg"); } },
    { item: "Board 3D model", keep: { kind: "board-model", eligible: scopeReady && !busy && !model.isFetching && !model.isError && model.data === "source-changed" }, status: !has("renders/board.glb") ? "Not generated" : model.isFetching ? "Checking source…" : model.isError ? "Could not check source" : model.data === "source-changed" ? "PCB source changed" : model.data === "artifact-changed" ? "Model file changed" : model.data === "source-unchanged" ? "PCB unchanged since export" : "Source unverified", warning: ["source-changed", "artifact-changed"].includes(model.data ?? ""), note: "External component models and physical fit are not verified.", action: has("renders/board.glb") ? "Update model" : "Create model", disabled: !pcb || !scopeReady || busy, onClick: () => refresh("glb") },
    { item: "Generated enclosure", status: !has("enclosure.json") ? "Not generated" : enclosure.isFetching ? "Checking source…" : enclosure.isError ? "Could not check source" : enclosure.data === "changed" ? "PCB source changed" : enclosure.data === "unchanged" ? "Case source unchanged" : "Source unverified", warning: enclosure.data === "changed", note: "Review dimensions and fit before deliberately regenerating the case.", action: "Review enclosure", onClick: () => open("cad") },
    { item: "PCB checks", status: !has("reports/drc.json") ? "No saved DRC report" : checks.isFetching ? "Checking report source…" : checks.isError ? "Could not check source" : checks.data === "source-changed" ? "PCB changed since DRC" : checks.data === "source-unchanged" ? "PCB unchanged since DRC" : "Source unverified", warning: checks.data === "source-changed", note: "Matching source is not a pass. Review findings, ERC and schematic parity separately.", action: "Open checks", onClick: () => open("drc") },
    { item: "Schematic checks", status: !has("reports/erc.json") ? "No saved ERC report" : readiness.isFetching ? "Checking saved ERC evidence…" : readiness.isError ? "Could not check ERC evidence" : readiness.data?.checks.erc === "stale" ? "ERC needs updating" : readiness.data?.checks.erc === "not_applicable" ? "Incomplete or not applicable" : "Saved ERC report · review findings", warning: !readiness.isFetching && !readiness.isError && readiness.data?.checks.erc === "stale", note: "Re-run ERC against the current saved schematic when needed. This checks electrical rules; it does not synchronize the schematic with the PCB.", action: "Open checks", onClick: () => open("drc") },
    { item: "Other saved outputs", status: "Freshness not yet tracked", warning: false, note: "Other images and manufacturing files retain their saved versions. Review before sharing or fabrication.", action: "Browse outputs", onClick: () => open("renders") },
  ];
  return <div className="fd-review-updates" data-testid="review-updates">
    <header><h2>Choose what to update</h2><p>Review saved-source changes and choose the next step. Preview freshness, electrical checks and physical fit are separate.</p><Button size="sm" variant="ghost" onClick={() => retry([preview, model, enclosure, checks, readiness, video])}>Recheck sources</Button></header>
    <div className="fd-update-table" role="table" aria-label="Saved artifact source review">
      <div className="fd-update-row fd-update-table-heading" role="row"><span role="columnheader">Item</span><span role="columnheader">Source status</span><span role="columnheader">Next step</span></div>
      {rows.map(row => <div key={row.item} className="fd-update-row" role="row"><div role="cell"><strong>{row.item}</strong><details className="fd-review-source-details"><summary aria-label={`Source details for ${row.item}`}>Source details</summary><p>{row.note}</p></details></div><span role="cell" data-warning={row.warning}>{row.status}</span><div role="cell" className="fd-update-actions"><Button size="sm" disabled={row.disabled} onClick={row.onClick}>{row.action}</Button>{row.keep && <KeepSavedOutput key={`${projectId}:${row.keep.kind}`} projectId={projectId} kind={row.keep.kind} eligible={row.keep.eligible} />}</div></div>)}
    </div>
    {busy && <p role="status" className="fd-update-feedback"><Spinner />Updating the selected output…</p>}
    {update.state.error && <p role="alert" className="fd-update-feedback">{update.state.error}</p>}
    <section className="fd-update-sync"><div><h3>Schematic and PCB</h3><p>{pcb && schematic ? "A newer timestamp does not tell us which design should change. Review differences and choose a direction before applying an update." : "This project needs both a schematic and PCB before their relationship can be reviewed."}</p><small>Schematic/PCB equivalence is not verified by the source checks above.</small></div><Button size="sm" disabled={!pcb || !schematic} onClick={() => {
      const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return;
      const key = ui.activeThreadId ?? newChatDraftKey(projectId), previous = ui.drafts[key] ?? "";
      const prompt = "Review the saved schematic and PCB in this project. Explain their differences and which synchronization direction is appropriate. Do not apply changes or save an open native document until we choose a direction.";
      ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt); ui.focusComposer();
    }}>Ask about sync direction</Button></section>
  </div>;
}
