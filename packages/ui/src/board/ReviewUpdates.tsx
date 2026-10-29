import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { ReviewDesignSources, ReviewKeepNote, ReviewScope, ReviewUpdateTable } from "./ReviewUpdateLayout";
import type { IconName } from "../components/Icon";
import { KeepSavedOutput } from "./KeepSavedOutput";
import { videoInputLabel } from "./VideoSourceStatus";
import { CoreHttpError, useBoardSources, useProject, useProjectOrder, usePcbPreviewRevision, useBoardModelRevision, useEnclosureSourceRevision, usePcbCheckRevision, useRunTool, useVideoInputRevision, videoInputsNeedReview } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { AssemblyReviewUpdates } from "./AssemblyReviewUpdates";
import { newChatDraftKey, useUiStore } from "../stores/ui";

type Row = { group: "outputs" | "checks"; item: string; status: string; note: string; warning: boolean; action: string; keep?: { kind: "pcb-preview" | "board-model"; eligible: boolean }; disabled?: boolean; onClick: () => void };

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
  const previewSourceMissing = !pcb || preview.data === "missing-source", modelSourceMissing = !pcb || model.data === "missing-source", checkSourceMissing = !pcb || checks.data === "missing-source";
  const assistantSurface = projectId ? { projectId, label: "Review / Updates", priority: 10, details: JSON.stringify({ sourceReady: scopeReady, nativePcb: pcb, nativeSchematic: schematic, savedPreview: preview.data, savedModel: model.data, savedChecks: checks.data, savedVideo: video.data, sourceComparison: "not established by artifact freshness" }) } : null;
  useAssistantSurface(assistantSurface);
  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load project updates" onRetry={() => void project.refetch()} />;
  if (project.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const open = (tab: "pcb" | "3d" | "cad" | "drc" | "renders" | "files") => useUiStore.getState().setBoardTab(tab);
  const retry = (queries: Array<{ refetch: () => unknown }>) => { for (const query of queries) void query.refetch(); };
  const busy = update.state.status === "running";
  const refresh = (kind: "render_pcb_svg" | "glb") => {
    if (!scopeReady || busy || useUiStore.getState().activeProjectId !== projectId) return;
    void update.run(kind, { projectId });
  };
  const rows: Row[] = [
    ...(videoPath ? [{ group: "outputs" as const, item: "Product video", status: video.isFetching ? "Checking video inputs…" : video.isError ? "Could not check video inputs" : videoInputLabel(video.data), warning: videoInputsNeedReview(video.data), note: "Checks recorded model inputs and video bytes, including the PCB source of a tracked board model. Captions, newly added scene content and external model dependencies need separate review. Your saved video stays until you choose Make video.", action: "Review video", onClick: () => { if (useUiStore.getState().activeProjectId === projectId) { useUiStore.getState().setWorkspaceArea("outputs"); useUiStore.getState().setWorkspaceTab("3d"); } } }] : []),
    { group: "outputs", item: "PCB preview", keep: { kind: "pcb-preview", eligible: scopeReady && !busy && !preview.isFetching && !preview.isError && !previewSourceMissing && preview.data === "source-changed" }, status: !has("renders/pcb.svg") ? "Not generated" : preview.isFetching ? "Checking source…" : preview.isError ? "Could not check source" : previewSourceMissing ? "PCB source missing" : preview.data === "source-changed" ? "PCB source changed" : preview.data === "artifact-changed" ? "Preview file changed" : preview.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified", warning: has("renders/pcb.svg") && (previewSourceMissing || ["source-changed", "artifact-changed"].includes(preview.data ?? "")), note: "Updates the drawing from the saved PCB. Electrical checks stay separate.", action: previewSourceMissing ? "Open project files" : preview.data === "matches-source" && !preview.isError && !preview.isFetching ? "Open board" : has("renders/pcb.svg") ? "Update preview" : "Create preview", disabled: !scopeReady || busy || preview.isFetching, onClick: () => { if (useUiStore.getState().activeProjectId !== projectId) return; if (previewSourceMissing) open("files"); else if (preview.data === "matches-source" && !preview.isError) open("pcb"); else refresh("render_pcb_svg"); } },
    { group: "outputs", item: "Board 3D model", keep: { kind: "board-model", eligible: scopeReady && !busy && !model.isFetching && !model.isError && !modelSourceMissing && model.data === "source-changed" }, status: !has("renders/board.glb") ? "Not generated" : model.isFetching ? "Checking source…" : model.isError ? "Could not check source" : modelSourceMissing ? "PCB source missing" : model.data === "source-changed" ? "PCB source changed" : model.data === "artifact-changed" ? "Model file changed" : model.data === "source-unchanged" ? "PCB unchanged since export" : "Source unverified", warning: has("renders/board.glb") && (modelSourceMissing || ["source-changed", "artifact-changed"].includes(model.data ?? "")), note: "External component models and physical fit are not verified.", action: modelSourceMissing ? "Open project files" : model.data === "source-unchanged" && !model.isError && !model.isFetching ? "Open model" : has("renders/board.glb") ? "Update model" : "Create model", disabled: !scopeReady || busy || model.isFetching, onClick: () => { if (useUiStore.getState().activeProjectId !== projectId) return; if (modelSourceMissing) open("files"); else if (model.data === "source-unchanged" && !model.isError) open("3d"); else refresh("glb"); } },
    { group: "outputs", item: "Generated enclosure", status: !has("enclosure.json") ? "Not generated" : enclosure.isFetching ? "Checking source…" : enclosure.isError ? "Could not check source" : enclosure.data === "changed" ? "PCB source changed" : enclosure.data === "unchanged" ? "Case source unchanged" : "Source unverified", warning: enclosure.data === "changed", note: "Review dimensions and fit before deliberately regenerating the case.", action: "Review enclosure", onClick: () => open("cad") },
    { group: "checks", item: "PCB checks", status: !has("reports/drc.json") ? "No saved DRC report" : checks.isFetching ? "Checking report source…" : checks.isError ? "Could not check source" : checkSourceMissing ? "PCB source missing" : checks.data === "source-changed" ? "PCB changed since DRC" : checks.data === "source-unchanged" ? "PCB unchanged since DRC" : "Source unverified", warning: has("reports/drc.json") && (checkSourceMissing || checks.data === "source-changed"), note: "Matching source is not a pass. Review findings, ERC and schematic parity separately.", action: "Open checks", onClick: () => open("drc") },
    { group: "checks", item: "Schematic checks", status: !has("reports/erc.json") ? "No saved ERC report" : readiness.isFetching ? "Checking saved ERC evidence…" : readiness.isError ? "Could not check ERC evidence" : readiness.data?.checks.erc === "stale" ? "ERC needs updating" : readiness.data?.checks.erc === "not_applicable" ? "Incomplete or not applicable" : "Saved ERC report · review findings", warning: !readiness.isFetching && !readiness.isError && readiness.data?.checks.erc === "stale", note: "Re-run ERC against the current saved schematic when needed. This checks electrical rules; it does not synchronize the schematic with the PCB.", action: "Open checks", onClick: () => open("drc") },
    { group: "outputs", item: "Other saved outputs", status: "Freshness not yet tracked", warning: false, note: "Other images and manufacturing files retain their saved versions. Review before sharing or fabrication.", action: "Browse outputs", onClick: () => open("renders") },
  ];
  return <div className="fd-review-updates" data-testid="review-updates">
    <ReviewScope><span className="fd-review-single-scope">Main board</span></ReviewScope>
    <header><h2>Review updates</h2><p>Review your design sources and choose which saved outputs to update.</p><Button size="sm" variant="ghost" onClick={() => retry([preview, model, enclosure, checks, readiness, video])}>Recheck sources</Button></header>
    <ReviewDesignSources pcb={pcb ? "Saved source" : "Not added"} schematic={schematic ? "Saved source" : "Not added"} status={pcb && schematic ? "PCB and schematic · not compared" : "Both sources are needed for comparison"} note="Review the differences before choosing a synchronization direction." action={<Button size="sm" onClick={() => {
      const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return;
      if (!pcb || !schematic) { open("files"); return; }
      const key = ui.activeThreadId ?? newChatDraftKey(projectId), previous = ui.drafts[key] ?? "";
      const prompt = "Review the saved schematic and PCB in this project. Explain their differences and which synchronization direction is appropriate. Do not apply changes or save an open native document until we choose a direction.";
      ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt); ui.focusComposer();
    }}>{pcb && schematic ? "Ask about differences" : "Browse source files"}</Button>}>
      <details className="fd-review-sync-options"><DisclosureSummary icon="folderOpen" label="Source details & sync" variant="compact" /><p>A newer timestamp does not identify which design should change. Generated-output freshness does not establish schematic/PCB equivalence.</p><p>Ask the agent to review the intended direction and native source changes before saving. Some native preview tools also save the live schematic; the review must explain that before running them.</p><div><Button size="sm" onClick={() => assistantSurface && askAboutSurface(assistantSurface, "Review updating this PCB from the saved schematic. Explain the proposed footprint and connection changes, preserve board-only items, and identify any required native document saves before applying anything.")}>Review schematic → PCB</Button><Button size="sm" onClick={() => assistantSurface && askAboutSurface(assistantSurface, "Review bringing the saved PCB changes back into the schematic. Identify the electrical and footprint differences, explain what can be recovered, and propose native schematic edits without applying them yet.")}>Review PCB → schematic</Button></div></details>
    </ReviewDesignSources>
    {([{ id: "outputs", label: "Generated outputs" }, { id: "checks", label: "Saved checks" }] as const).map(group => <ReviewUpdateTable key={group.id} title={group.label} collapsed={group.id === "checks"} summaryStatus={readiness.data?.checks.drc === "fail" ? "Findings need review" : "PCB & schematic"} summaryWarning={readiness.data?.checks.drc === "fail"} rows={rows.filter(row => row.group === group.id && row.item !== "Other saved outputs" && (row.item !== "Generated enclosure" || has("enclosure.json"))).sort((a,b) => (a.item === "Board 3D model" ? 0 : a.item === "PCB preview" ? 1 : 2) - (b.item === "Board 3D model" ? 0 : b.item === "PCB preview" ? 1 : 2)).map(row => ({
      key: row.item, item: row.item === "Board 3D model" ? "3D model" : row.item === "Product video" ? "Review video" : row.item,
      icon: ({"Board 3D model":"cube","Product video":"play","PCB preview":"image","Generated enclosure":"cube","PCB checks":"checkCircle","Schematic checks":"schematic"} as Record<string,IconName>)[row.item] ?? "folder",
      status: row.status, warning: row.warning,
      note: row.item === "Board 3D model" ? "Component dependencies and fit are unverified." : row.item === "Product video" ? "Recorded inputs only; review the saved scene before sharing." : row.item === "PCB preview" ? "Drawing generated from the saved PCB." : row.item.endsWith("checks") ? "Source freshness and check findings are separate." : "Review the saved inputs before updating.",
      details: <p>{row.note}</p>,
      actions: <><Button size="sm" data-update={row.action.startsWith("Update") || row.action.startsWith("Create")} disabled={row.disabled} onClick={row.onClick}>{row.action}</Button>{row.keep && <KeepSavedOutput key={`${projectId}:${row.keep.kind}`} projectId={projectId} kind={row.keep.kind} eligible={row.keep.eligible} />}</>,
    }))} />)}
    <ReviewKeepNote />
    <Button size="sm" variant="ghost" className="fd-review-browse-outputs" onClick={() => open("renders")}>Browse all saved outputs</Button>
    {busy && <p role="status" className="fd-update-feedback"><Spinner />Updating the selected output…</p>}
    {update.state.error && <p role="alert" className="fd-update-feedback">{update.state.error}</p>}

  </div>;
}
