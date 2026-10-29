import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { useState } from "react";
import { ASSEMBLY_MANIFEST_PATH, type ProjectBoardSources } from "@fabdesk/protocol";
import { overviewBoardImages, restoreAssemblySelection, assemblyModelNeedsReview, assemblyModelSummaryLabel, useAssemblyModelSummaries, assemblyCheckNeedsReview, assemblyCheckSummaryLabel, useAssemblyCheckSummaries, assemblyReviewRows, useAssemblyPreviewRevisions, useProject, useRunTool, useVideoInputRevision, videoInputsNeedReview } from "@fabdesk/client-core";
import { videoInputLabel } from "./VideoSourceStatus";
import { Button, Spinner } from "../components/ui";
import { ReviewDesignSources, ReviewKeepNote, ReviewScope, ReviewUpdateTable, type ReviewOutputRow } from "./ReviewUpdateLayout";
import { useUiStore } from "../stores/ui";

export function AssemblyReviewUpdates({ projectId, data, checking, failed, onRetry }: { projectId: string; data: ProjectBoardSources; checking: boolean; failed: boolean; onRetry: () => void }) {
  const project = useProject(projectId), previews = useAssemblyPreviewRevisions(projectId, data.sources), update = useRunTool();
  const checks = useAssemblyCheckSummaries(projectId, data), checkById = new Map((checks.data ?? []).map(row => [row.sourceId, row]));
  const models = useAssemblyModelSummaries(projectId, data), modelById = new Map((models.data ?? []).map(row => [row.sourceId, row]));
  const [updatingSource, setUpdatingSource] = useState<string | null>(null);
  const [requestedScope, setRequestedScope] = useState(() => restoreAssemblySelection(data, useUiStore.getState().assemblyBoardByProject[projectId])?.sourceId ?? null);
  const attentionSources = new Set([
    ...(!checks.isFetching && !checks.isError ? (checks.data ?? []).filter(assemblyCheckNeedsReview).map(row => row.sourceId) : []),
    ...(!models.isFetching && !models.isError ? (models.data ?? []).filter(assemblyModelNeedsReview).map(row => row.sourceId) : []),
  ]);
  const rows = assemblyReviewRows(data, new Map(previews.map(preview => [preview.sourceId, preview])), attentionSources);
  const scope = requestedScope === "all" ? "all" : rows.some(row => row.sourceId === requestedScope) ? requestedScope : rows.find(row => row.board)?.sourceId ?? rows[0]?.sourceId;
  const row = rows.find(item => item.sourceId === scope), declared = data.sources.find(item => item.source.id === scope);
  const busy = update.state.status === "running", unavailable = checking || failed;
  const active = () => useUiStore.getState().activeProjectId === projectId;
  const ask = (sourceId: string, name: string, compare = false) => {
    if (!active()) return;
    const target = rows.find(row => row.sourceId === sourceId);
    const prompt = compare ? `Compare the saved PCB and schematic for ${name}. Find a matching schematic in the project if it is missing, and explain any differences before changing sources.` : `Review ${name}. Explain missing files, source changes, and which boards are affected.`;
    askAboutSurface({ projectId, label: `Review / ${name}`, priority: 40, details: JSON.stringify({ board: target?.board, sourceId, manifestSha256: data.manifestSha256, source: data.sources.find(row => row.source.id === sourceId)?.source, request: "Inspect native sources and shared ownership before proposing changes. Artifact freshness does not establish electrical compatibility." }) }, prompt);
  };
  const refresh = async (target: typeof rows[number]) => {
    if (!target.board || busy || unavailable || !active()) return;
    setUpdatingSource(target.sourceId);
    await update.run("render_pcb_svg", { projectId, board: { ...target.board } });
    if (active()) { onRetry(); void previews.find(preview => preview.sourceId === target.sourceId)?.refetch(); }
  };
  const openSource = (target: typeof rows[number], tab: "pcb" | "schematic" | "drc" | "3d") => {
    if (!active() || unavailable || busy || !target.selection) return;
    const ui = useUiStore.getState(), previous = restoreAssemblySelection(data, ui.assemblyBoardByProject[projectId]);
    ui.setAssemblyBoard(previous?.sourceId === target.sourceId ? previous : target.selection); ui.setBoardTab(tab);
  };
  const browse = (path: string) => { if (active() && !unavailable && !busy) useUiStore.getState().openProjectFile(path); };
  const files = project.data?.files ?? [];
  const prefix = declared?.source.location === "project" && declared.source.directory !== "." ? `${declared.source.directory}/` : "";
  const hasSchematic = !!row?.board && (!!declared?.schematicPath || files.some(file => file.path === prefix + "board.kicad_sch"));
  const modelStatus = unavailable ? "Source check unavailable" : models.isFetching ? "Checking model source…" : models.isError ? "Could not check model source" : modelById.get(scope ?? "")?.state === "source-unchanged" ? "PCB unchanged since export" : assemblyModelSummaryLabel(modelById.get(scope ?? ""));
  const checkStatus = unavailable ? "Source check unavailable" : checks.isFetching ? "Checking PCB report…" : checks.isError ? "Could not check saved report" : assemblyCheckSummaryLabel(checkById.get(scope ?? ""));
  const selectedPreview = previews.find(preview => preview.sourceId === row?.sourceId);
  const images = row ? overviewBoardImages(files, { sources: data.sources, sourceId: row.sourceId }) : [];
  const savedRender = images.find(image => image.kind === "top" || image.kind === "render");
  const video = row?.board ? files.find(file => ["mp4", "webm", "gif"].some(ext => file.path === `${prefix}exports/product-video.${ext}`)) : undefined;
  const videoRevision = useVideoInputRevision(projectId, video?.path);
  const videoStatus = unavailable ? "Source check unavailable" : videoRevision.isFetching ? "Checking video inputs…" : videoRevision.isError ? "Video inputs could not be checked" : videoInputLabel(videoRevision.data);
  const assistantSurface = { projectId, label: "Review / Updates", priority: 10, details: JSON.stringify({ scope, board: row?.board, source: declared?.source, previewStatus: row?.status, nativeSchematic: hasSchematic, modelStatus, checkStatus, savedImage: savedRender?.path, video: video ? { path: video.path, state: videoRevision.data, status: videoStatus } : null, sourceCheckPending: unavailable, updating: busy, instruction: "Artifact source receipts and saved findings do not establish electrical parity or assembly compatibility." }) };
  useAssistantSurface(assistantSurface);
  const outputs: ReviewOutputRow[] = row && !row.board ? [{key:"unavailable",item:"Board outputs",icon:"folder",status:row.status,warning:true,note:"Resolve the native source to review its saved outputs.",actions:<Button size="sm" disabled={unavailable || busy} onClick={() => browse(ASSEMBLY_MANIFEST_PATH)}>Source details</Button>}] : row ? [
    { key: "model", item: "3D model", icon: "cube", status: modelStatus, warning: assemblyModelNeedsReview(modelById.get(row.sourceId)), note: "External component models and physical fit remain unverified.", actions: <Button size="sm" disabled={unavailable || busy || !row.selection} onClick={() => openSource(row, "3d")}>Review model</Button> },
    { key: "preview", item: "Board preview", icon: "image", status: unavailable ? "Source check unavailable" : row.status, warning: row.warning, note: "Saved PCB drawing · electrical checks stay separate.", actions: row.board ? <Button size="sm" data-update={!row.previewCurrent} disabled={unavailable || busy || !!selectedPreview?.isFetching} onClick={() => row.previewCurrent ? openSource(row, "pcb") : void refresh(row)}>{busy && updatingSource === row.sourceId ? "Updating preview…" : row.previewCurrent ? "Open board" : row.hasPreview ? "Update preview" : "Create preview"}</Button> : <Button size="sm" disabled={unavailable || busy} onClick={() => ask(row.sourceId, row.name)}>Resolve source</Button> },
    ...(savedRender ? [{ key: "image", item: savedRender.kind === "top" ? "Top board image" : "Board image", icon: "image" as const, status: "Saved image · source unverified", note: "Review this saved render before sharing it.", actions: <Button size="sm" disabled={unavailable || busy} onClick={() => browse(savedRender.path)}>Review image</Button> }] : []),
    ...(video ? [{ key: "video", item: "Review video", icon: "play" as const, status: videoStatus, warning: videoInputsNeedReview(videoRevision.data), note: "Recorded video and model inputs only; captions, scene content and external dependencies need separate review.", actions: <Button size="sm" disabled={unavailable || busy} onClick={() => browse(video.path)}>Preview video</Button> }] : []),
  ] : [];
  const sourceTiles = <div className="fd-review-source-grid">{rows.map(item => <button key={item.sourceId} className="fd-review-source-tile" data-warning={item.warning || attentionSources.has(item.sourceId)} disabled={unavailable || busy} onClick={() => setRequestedScope(item.sourceId)}><strong>{item.name}</strong><small>{item.status}</small><small>{item.instances.length} {item.instances.length === 1 ? "board" : "boards"}{attentionSources.has(item.sourceId) ? " · Review checks or model" : ""}</small></button>)}</div>;
  return <div className="fd-review-updates" data-testid="assembly-review-updates">
    <ReviewScope><select aria-label="Review board scope" value={scope ?? "all"} disabled={unavailable || busy} onChange={event => setRequestedScope(event.target.value)}><option value="all">All boards</option>{rows.map(item => <option key={item.sourceId} value={item.sourceId}>{item.name}</option>)}</select></ReviewScope>
    <header><h2>Review updates</h2><p>Review your design sources and choose which saved outputs to update.</p><Button size="sm" variant="ghost" disabled={busy || checking} onClick={() => { onRetry(); void project.refetch(); void checks.refetch(); void models.refetch(); void videoRevision.refetch(); for (const preview of previews) if (preview.trackable) void preview.refetch(); }}>Recheck sources</Button></header>
    {failed && <p role="alert" className="fd-update-feedback">Project sources could not be refreshed. Retry before choosing a board or updating an output.</p>}
    {row ? <>
      <ReviewDesignSources pcb={unavailable ? "Checking source…" : row.board ? "Saved source" : "Unavailable"} schematic={hasSchematic ? "Saved source" : "Not added"} status={unavailable ? "Source check unavailable" : !row.board ? row.status : hasSchematic ? "PCB and schematic · not compared" : "Schematic needed for comparison"} note={row.instances.length > 1 ? `Shared design · ${row.instances.length} boards. Review differences before choosing a direction.` : "Review the native sources before choosing a synchronization direction."} action={<Button size="sm" disabled={unavailable || busy} onClick={() => ask(row.sourceId, row.name, !!row.board)}>{!row.board ? "Resolve source" : hasSchematic ? "Ask about differences" : "Find schematic with agent"}</Button>}>
        <details><DisclosureSummary icon="folderOpen" label="Source details & sync" variant="compact" /><p>{row.name} · {row.note}</p><p>{declared?.reason ?? (declared?.source.location === "project" ? `Source folder: ${declared.source.directory}` : "Resolve the source before opening its design.")}</p>{declared?.source.provenance && <p className="fd-review-origin">Declared origin · unverified: {declared.source.provenance.repository} · {declared.source.provenance.ref} · {declared.source.provenance.path}</p>}<p>Review the intended source direction with the agent. Matching output receipts do not establish PCB–schematic equivalence or assembly compatibility.</p><div><Button size="sm" onClick={() => askAboutSurface(assistantSurface, `Review updating the PCB for ${row.name} from its saved schematic. Check source ownership, shared board instances and native tool support; explain the changes and any native saves before applying them.`)}>Review schematic → PCB</Button><Button size="sm" onClick={() => askAboutSurface(assistantSurface, `Review reflecting the PCB changes for ${row.name} in its schematic. Check the exact saved sources and shared instances, explain differences, and propose changes without applying them yet.`)}>Review PCB → schematic</Button></div><Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => browse(ASSEMBLY_MANIFEST_PATH)}>Open project definition</Button>{hasSchematic && <Button size="sm" variant="ghost" disabled={unavailable || busy} onClick={() => openSource(row, "schematic")}>Open schematic</Button>}</details>
      </ReviewDesignSources>
      <ReviewUpdateTable title="Generated outputs" rows={outputs} />
      <ReviewKeepNote />
      <ReviewUpdateTable title="Saved checks" collapsed summaryStatus={checkStatus} summaryWarning={assemblyCheckNeedsReview(checkById.get(row.sourceId)) || (checkById.get(row.sourceId)?.findingCount ?? 0) > 0} rows={[{key:"pcb-checks",item:"PCB checks",icon:"checkCircle",status:checkStatus,warning:assemblyCheckNeedsReview(checkById.get(row.sourceId)) || (checkById.get(row.sourceId)?.findingCount ?? 0) > 0,note:"PCB-only report. A matching source is not a passed check.",actions:<Button size="sm" disabled={unavailable || busy || !row.selection} onClick={() => openSource(row,"drc")}>Review findings</Button>}]} />
      <details className="fd-review-source-summary"><DisclosureSummary icon="library" label="Project boards" badge={`${rows.length} source designs`} />{sourceTiles}</details>
    </> : <section className="fd-review-source-summary"><h3>Design sources</h3><p>Choose a board to review its sources, outputs and saved checks.</p>{sourceTiles}</section>}
    {busy && <p role="status" className="fd-update-feedback"><Spinner />Updating one source preview; shared boards use the same drawing.</p>}
    {update.state.error && <p role="alert" className="fd-update-feedback">{update.state.error}</p>}
  </div>;
}
