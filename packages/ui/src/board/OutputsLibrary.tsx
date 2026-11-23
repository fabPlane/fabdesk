import { buildZip } from "@fabdesk/board-art";
import { assemblyModelNeedsReview,assemblyModelSummaryLabel,filterSavedOutputs,outputCards,outputInputsNeedReview,outputRevisionLabel,readOutputSelection,refreshProjectPreviews,savedOutputs,useAssemblyModelSummaries,useAssemblyPreviewRevisions,useBoardModelRevision,useBoardSources,useCoreClient,useEnclosureSourceRevision,useOutputRevisions,useOutputTrashReview,usePcbPreviewRevision,useProject,useRunTool,useVideoInputRevisions,videoInputsNeedReview,type OutputKind } from "@fabdesk/client-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect,useRef,useState } from "react";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { FeedbackNotice } from "../components/FeedbackNotice";
import { Icon } from "../components/Icon";
import { Button,Dialog,EmptyState,LoadError,Select,Spinner } from "../components/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useUiStore } from "../stores/ui";
import { basename } from "../util";
import { BoardImageOutput } from "./BoardImageOutput";
import { formatFileSize } from "./file-explorer";
import { OutputPreviewDialog } from "./OutputPreviewDialog";
import { OutputTrashDialog } from "./OutputTrashDialog";
import { videoInputLabel } from "./VideoSourceStatus";
const FILTERS = [{ id: "all", label: "All" }, { id: "images", label: "Images" }, { id: "videos", label: "Videos" }, { id: "models", label: "Models" }, { id: "manufacturing", label: "Manufacturing" }] as const;

/** Open a preview directly; explicit checkboxes select files for single or batch download. */
export function OutputsLibrary({ projectId }: { projectId: string | null }) {
  const client = useCoreClient(), project = useProject(projectId), generate = useRunTool();
  const queries = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<OutputKind | "all">("all"), [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selected = selectedPaths.length === 1 ? selectedPaths[0] ?? null : null;
  const selectAll = useRef<HTMLInputElement>(null);
  const [imageOutput, setImageOutput] = useState(false);
  const [query, setQuery] = useState(""), [sourceScope, setSourceScope] = useState("all"), [reviewOnly, setReviewOnly] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null), [downloading, setDownloading] = useState(false), [error, setError] = useState<string | null>(null);
  const library = useRef<HTMLDivElement>(null), manufacturingFilter = useRef<HTMLButtonElement>(null);
  const boardSources = useBoardSources(projectId), assembly = boardSources.data?.mode === "assembly";
  const sourceReady = !!boardSources.data && !boardSources.isFetching && !boardSources.isError;
  const hasPcb = project.data?.files.some(file => file.path === "board.kicad_pcb") ?? false;
  const rootGenerationReady = sourceReady && !assembly && hasPcb && !project.isFetching && !project.isError;
  const memberPreviews = useAssemblyPreviewRevisions(projectId ?? "", assembly ? boardSources.data?.sources ?? [] : []);
  const memberModels = useAssemblyModelSummaries(projectId ?? "", assembly ? boardSources.data : undefined, !boardSources.isFetching && !boardSources.isError);
  const outputs = savedOutputs(project.data?.files ?? [], assembly ? boardSources.data?.sources : []), active = outputs.find(file => file.path === selected), matching = filterSavedOutputs(outputs, { kind: filter, query, ...(sourceScope === "project" ? { sourceId: null } : sourceScope.startsWith("source:") ? { sourceId: sourceScope.slice(7) } : {}) });
  const deletionReview = useOutputTrashReview(projectId, outputs);
  const [trash, setTrash] = useState<{ paths: string[] | null } | null>(null);
  const eligibility = (path: string) => deletionReview.data?.files.find(file => file.path === path);
  const removalReason = (path: string) => deletionReview.projectActive ? "An active project task may be using this output. Wait or cancel it in Project activity." : deletionReview.isFetching ? "Checking whether this output can be moved…" : deletionReview.isError ? "Output removal check unavailable. Refresh the check." : eligibility(path)?.reason ?? "Output removal check unavailable.";
  const modelRevision = useBoardModelRevision(projectId, sourceReady && !assembly && outputs.some(file => file.path === "renders/board.glb"));
  const pcbRevision = usePcbPreviewRevision(projectId, sourceReady && !assembly && outputs.some(file => file.path === "renders/pcb.svg"));
  const enclosureRevision = useEnclosureSourceRevision(projectId, sourceReady && !assembly && outputs.some(file => file.path === "exports/enclosure.stl"));
  const videoRevisions = useVideoInputRevisions(projectId, sourceReady ? outputs.filter(file => /(^|\/)exports\/product-video\.(mp4|webm|gif)$/i.test(file.path)).map(file => file.path) : []);
  const outputRevisions = useOutputRevisions(projectId, outputs.filter(file => !/(?:^|\/)renders\/(?:board\.glb|pcb\.svg)$|(?:^|\/)exports\/(?:enclosure\.stl|product-video\.(?:mp4|webm|gif))$/i.test(file.path)).flatMap(file => {
    const source = file.sourceId ? boardSources.data?.sources.find(row => row.source.id === file.sourceId) : null;
    if (assembly && !source || source && source.source.location !== "project") return [];
    return [{ path: file.path, directory: source?.source.location === "project" ? source.source.directory : ".", ...(source && boardSources.data?.manifestSha256 ? { board: { sourceId: source.source.id, manifestSha256: boardSources.data.manifestSha256 } } : {}) }];
  }), sourceReady);
  const recordedInfo = (path: string) => {
    const result = outputRevisions.find(row => row.path === path);
    return result ? { warning: !result.isFetching && !result.isError && outputInputsNeedReview(result.data), label: result.isFetching || result.isPending ? "Checking recorded inputs…" : result.isError ? "Output source check unavailable" : outputRevisionLabel(result.data) } : { warning: false, label: "Source not checked" };
  };
  const sourceInfo = (path: string) => {
    if (!sourceReady) return { warning: false, label: boardSources.isError ? "Board source check unavailable" : "Checking board source…" };
    const member = outputs.find(file => file.path === path);
    if (member?.sourceId) {
      if (boardSources.isFetching) return { warning: false, label: "Checking board source…" };
      if (boardSources.isError) return { warning: false, label: "Board source check unavailable" };
      const source = boardSources.data?.sources.find(row => row.source.id === member.sourceId);
      if (source?.status === "missing") return { warning: true, label: "PCB source missing · Saved output" };
      if (path.endsWith("/renders/board.glb") || path === "renders/board.glb") {
        const model = memberModels.data?.find(row => row.sourceId === member.sourceId);
        return { warning: !memberModels.isFetching && !memberModels.isError && assemblyModelNeedsReview(model), label: memberModels.isFetching ? "Checking model source…" : memberModels.isError ? "Model source check unavailable" : assemblyModelSummaryLabel(model) };
      }
      if (path.endsWith("/renders/pcb.svg") || path === "renders/pcb.svg") {
        const preview = memberPreviews.find(row => row.sourceId === member.sourceId);
        return { warning: !preview?.isFetching && !preview?.isError && ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(preview?.data ?? ""), label: preview?.isFetching ? "Checking preview source…" : preview?.isError ? "Preview source check unavailable" : preview?.data === "missing-source" ? "PCB source missing · Saved output" : preview?.data === "missing-artifact" ? "Saved preview file missing" : preview?.data === "source-changed" ? "PCB changed · Review preview" : preview?.data === "artifact-changed" ? "Preview changed · Source unverified" : preview?.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified" };
      }
      const video = videoRevisions.find(row => row.path === path);
      if (video) return { warning: videoInputsNeedReview(video.data), label: video.isFetching ? "Checking video inputs…" : video.isError ? "Video inputs could not be checked" : videoInputLabel(video.data) };
      return recordedInfo(path);
    }
    if (assembly) return { warning: false, label: "Project output · Source unverified" };
    if (path === "renders/board.glb") return { warning: !hasPcb || ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(modelRevision.data ?? ""), label: modelRevision.isFetching ? "Checking model source…" : modelRevision.isError ? "Model source check unavailable" : !hasPcb || modelRevision.data === "missing-source" ? "PCB source missing · Saved output" : modelRevision.data === "missing-artifact" ? "Saved model file missing" : modelRevision.data === "source-changed" ? "PCB changed · Review model" : modelRevision.data === "artifact-changed" ? "Model changed · Source unverified" : modelRevision.data === "source-unchanged" ? "PCB unchanged · Model dependencies unverified" : "Source unverified" };
    if (path === "renders/pcb.svg") return { warning: !hasPcb || ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(pcbRevision.data ?? ""), label: pcbRevision.isFetching ? "Checking preview source…" : pcbRevision.isError ? "Preview source check unavailable" : !hasPcb || pcbRevision.data === "missing-source" ? "PCB source missing · Saved output" : pcbRevision.data === "missing-artifact" ? "Saved preview file missing" : pcbRevision.data === "source-changed" ? "PCB changed · Review preview" : pcbRevision.data === "artifact-changed" ? "Preview changed · Source unverified" : pcbRevision.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified" };
    if (path === "exports/enclosure.stl") return { warning: enclosureRevision.data === "changed", label: enclosureRevision.isFetching ? "Checking case source…" : enclosureRevision.isError ? "Case source check unavailable" : enclosureRevision.data === "changed" ? "PCB changed · Review case" : enclosureRevision.data === "unchanged" ? "Case source unchanged · Fit unverified" : "Case source unverified" };
    const video = videoRevisions.find(row => row.path === path);
    if (video) return { warning: !video.isFetching && !video.isError && videoInputsNeedReview(video.data), label: video.isFetching || video.isPending ? "Checking video inputs…" : video.isError ? "Video inputs could not be checked" : videoInputLabel(video.data) };
    return recordedInfo(path);
  };
  const needsReview = (files: { path: string }[]) => files.some(file => sourceInfo(file.path).warning);
  const reviewCount = outputCards(outputs, true).filter(group => needsReview(group.files)).length;
  const cards = outputCards(matching, filter === "all").filter(group => !reviewOnly || needsReview(group.files));
  const visiblePaths = new Set(cards.flatMap(group => group.files.map(file => file.path)));
  const shown = matching.filter(file => visiblePaths.has(file.path));
  const visiblePathKey = JSON.stringify(shown.map(file => file.path));
  const removable = deletionReview.projectActive ? [] : shown.filter(file => selectedPaths.includes(file.path) && eligibility(file.path)?.eligible);
  const sections = [
    { id: "media", label: "Images & videos", cards: cards.filter(group => group.primary.kind === "images" || group.primary.kind === "videos") },
    { id: "files", label: "Models & files", cards: cards.filter(group => group.primary.kind !== "images" && group.primary.kind !== "videos") },
  ];
  const [chosenFormats, setChosenFormats] = useState<Record<string, string>>({});
  const selectedFiles = shown.filter(file => selectedPaths.includes(file.path));
  const allSelected = shown.length > 0 && selectedFiles.length === shown.length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedFiles.length > 0 && !allSelected; }, [selectedFiles.length, allSelected]);
  const visible = outputs.find(file => file.path === preview);
  const assistantSurface = projectId ? { projectId, label: visible ? `Output preview · ${basename(visible.path)}` : "Outputs / Library", priority: visible ? 40 : 5, details: JSON.stringify({ view: "Saved output library", preview: visible ? { path: visible.path, sourceId: visible.sourceId, sourceName: visible.sourceName, status: sourceInfo(visible.path).label } : null, selected: selectedPaths.slice(0, 20), sourceFilter: sourceScope, kindFilter: filter, needsReviewOnly: reviewOnly }) } : null;
  useAssistantSurface(assistantSurface);
  useEffect(() => { const visible = new Set(shown.map(file => file.path)); setSelectedPaths(previous => { const next = previous.filter(path => visible.has(path)); return next.length === previous.length ? previous : next; }); }, [visiblePathKey]);
  const deselect = () => {
    [...(library.current?.querySelectorAll<HTMLInputElement>(".fd-output-checkbox") ?? [])].find(card => card.dataset.path === selectedPaths[0])?.focus();
    setSelectedPaths([]);
  };
  const refresh = async () => {
    if (!projectId || refreshing) return;
    setRefreshing(true); setError(null);
    try {
      await Promise.all([project.refetch({ throwOnError: true }), refreshProjectPreviews(queries, client.baseUrl, projectId)]);
    } catch {
      if (useUiStore.getState().activeProjectId === projectId) setError("Could not refresh all outputs. Check the connection, then use Refresh outputs to try again. Saved files have not been changed.");
    } finally { setRefreshing(false); }
  };
  const download = async (files = selectedFiles) => {
    if (!files.length || !projectId || downloading) return;
    const captured = [...files];
    setDownloading(true); setError(null);
    try {
      const entries = await readOutputSelection(client, projectId, captured);
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const bytes = entries.length === 1 ? entries[0]!.data : buildZip(entries);
      const blob = new Blob([Uint8Array.from(bytes).buffer], { type: entries.length > 1 ? "application/zip" : "application/octet-stream" });
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = entries.length === 1 ? basename(entries[0]!.name) : "fabPlane-outputs.zip"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
    catch (failure) { setError(failure instanceof Error ? `Could not download the selection. ${failure.message}` : "Could not download the selection. Try again."); }
    finally { setDownloading(false); }
  };

  const create = (kind: "render" | "glb" | "video" | "files") => {
    if (!projectId || useUiStore.getState().activeProjectId !== projectId || kind !== "files" && !sourceReady) return;
    if (assembly && kind === "glb") { useUiStore.getState().setWorkspaceTab("3d"); return; }
    if (kind === "render") { setImageOutput(true); return; }
    if (!assembly && kind !== "files" && !hasPcb) return;
    if (!assembly && kind !== "files" && !rootGenerationReady) return;
    if (kind === "video" || kind === "files") useUiStore.getState().setWorkspaceTab(kind === "video" ? "3d" : "files");
    else void generate.run(kind, { projectId });
  };
  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load outputs" onRetry={() => void project.refetch()} />;
  if (project.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div ref={library} className="fd-outputs-library" data-testid="outputs-library" onKeyDown={event => {
    if (event.key === "Escape" && selectedPaths.length && !preview && !trash) { event.stopPropagation(); deselect(); }
  }}>
    <header className="fd-output-library-heading">
      <div><h2>Saved outputs</h2><p>Images, videos, models and manufacturing files from this project.</p></div>
      <CanvasToolButton icon="refresh" label={refreshing ? "Refreshing outputs…" : "Refresh outputs"} disabled={refreshing} onClick={() => void refresh()} />
      {(reviewCount > 0 || reviewOnly) && <Button className="fd-output-review" size="sm" variant="ghost" aria-pressed={reviewOnly} onClick={() => { setReviewOnly(value => !value); setSelectedPaths([]); setError(null); }}><Icon name="warning" width={16} height={16} />{reviewOnly ? "Needs review only" : "Needs review"} · {reviewCount}<Icon name={reviewOnly ? "check" : "filter"} width={14} height={14} /><span>{reviewOnly ? "Filter on" : "Filter"}</span></Button>}
      <Button data-testid="output-trash-open" variant="ghost" onClick={() => setTrash({ paths: null })}><Icon name="trash" width={17} height={17} />Trash</Button>
      <Button variant="primary" disabled={!sourceReady || !assembly && !hasPcb || generate.state.status === "running"} onClick={() => create("render")}><Icon name="image" width={18} height={18} />Render board image</Button>
      <WorkspaceMenu className="fd-output-create" label={<><span>Create output</span><Icon name="plus" width={16} height={16} /></>}>
        {!sourceReady && <div className="fd-menu-caption">{boardSources.isError ? "Board sources could not be checked." : "Checking board sources…"}</div>}
        {boardSources.isError && <button onClick={() => void boardSources.refetch()}>Retry source check</button>}
        {sourceReady && !assembly && !hasPcb && <><div className="fd-menu-caption">Add a saved PCB in Board to create images, models or videos.</div><button onClick={() => useUiStore.getState().setBoardTab("pcb")}>Open Board</button></>}
        <button disabled={!sourceReady || !assembly && !rootGenerationReady || generate.state.status === "running"} title={!assembly && !hasPcb ? "Add a saved PCB first" : undefined} onClick={() => { const ui = useUiStore.getState(); ui.setWorkspaceArea("boards"); ui.setBoardTab("3d"); }}>Open board model</button>
        <button disabled={!sourceReady || !assembly && !hasPcb} onClick={() => create("video")}>Make video…</button>
        <button onClick={() => create("files")}>Export files…</button>
      </WorkspaceMenu>
    </header>
    <div className="fd-output-toolbar">
    <div className="fd-output-discovery" aria-label="Find saved outputs">
      <label className="fd-output-search"><Icon name="search" width={16} height={16} /><input ref={search} aria-label="Find saved outputs" placeholder="Find an output…" value={query} onChange={event => { setQuery(event.target.value); setSelectedPaths([]); setError(null); }} /></label>
      {assembly && <label className="fd-output-scope">Source<Select aria-label="Filter output source" value={sourceScope} onChange={event => { setSourceScope(event.target.value); setSelectedPaths([]); setError(null); }}><option value="all">All sources</option><option value="project">Project outputs</option>{boardSources.data?.sources.map(row => <option key={row.source.id} value={`source:${row.source.id}`}>{row.source.name}</option>)}{sourceScope.startsWith("source:") && !boardSources.data?.sources.some(row => `source:${row.source.id}` === sourceScope) && <option value={sourceScope} disabled>Source unavailable</option>}</Select></label>}
      <span role="status">{cards.length} {cards.length === 1 ? "output" : "outputs"} · {shown.length} {shown.length === 1 ? "file" : "files"}</span><span className="text-xs text-muted" title="Uses completed export time when recorded for these exact bytes, otherwise file saved time. Opening or downloading does not change the order.">Newest first · export or file time</span>
      {(query || sourceScope !== "all" || filter !== "all" || reviewOnly) && <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSourceScope("all"); setFilter("all"); setReviewOnly(false); setSelectedPaths([]); setError(null); search.current?.focus(); }}>Clear filters</Button>}
    </div>
      <div className="fd-output-filters" role="group" aria-label="Filter saved outputs">{FILTERS.map(item => <Button ref={item.id === "manufacturing" ? manufacturingFilter : undefined} size="sm" key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setSelectedPaths([]); }}>{item.label}</Button>)}</div>

    </div>
    {reviewOnly && <div className="fd-output-active-filter" role="status"><Icon name="filter" width={16} height={16} /><strong>Needs review filter is on</strong><span>Showing {cards.length} matching {cards.length === 1 ? "output" : "outputs"}</span><Button size="sm" onClick={() => setReviewOnly(false)}><Icon name="close" width={14} height={14} />Clear review filter</Button></div>}
    {deletionReview.isError && <FeedbackNotice className="fd-task-feedback" tone="warning" title="Output removal check unavailable" actions={<Button size="sm" variant="ghost" onClick={() => void deletionReview.refetch()}>Retry removal check</Button>}>Preview and download remain available.</FeedbackNotice>}
    {generate.state.status === "running" && <FeedbackNotice className="fd-task-feedback" tone="progress" title="Creating output">The result will appear in this library when the task finishes.</FeedbackNotice>}
    {(error || generate.state.error) && <FeedbackNotice className="fd-task-feedback" tone="error" title="Output action did not finish">{error || generate.state.error}</FeedbackNotice>}
    {shown.length > 0 && <label className="fd-output-select-all"><input ref={selectAll} type="checkbox" checked={allSelected} aria-label="Select all matching outputs" onChange={() => setSelectedPaths(allSelected ? [] : shown.map(file => file.path))} />Select all {shown.length} {shown.length === 1 ? "file" : "files"}</label>}
    {selectedFiles.length > 0 && <div className="fd-output-selected" data-testid="output-actions">
      <div className="fd-output-action-bar"><span className="fd-output-selection-count">{selectedFiles.length} {selectedFiles.length === 1 ? "file" : "files"} selected</span>{active ? <strong title={active.path}>{basename(active.path)}{active.sourceName && <small> · {active.sourceName}</small>}</strong> : <strong>Actions for the selected files</strong>}
        <Button size="sm" disabled={downloading} onClick={() => void download()}>{downloading ? "Preparing download…" : selectedFiles.length > 1 ? "Download ZIP" : "Download"}</Button>
        <Button size="sm" disabled={deletionReview.projectActive || deletionReview.isFetching || !removable.length} title={removable.length ? `${removable.length} files can be moved; review the exact list first.` : selectedFiles.map(file => `${file.path}: ${removalReason(file.path)}`).join("\n")} onClick={() => setTrash({ paths: selectedFiles.map(file => file.path) })}><Icon name="trash" width={15} height={15} />Move to Trash{removable.length !== selectedFiles.length ? ` · ${removable.length} of ${selectedFiles.length}` : ""}</Button>
        {(deletionReview.projectActive || !deletionReview.isFetching) && removable.length !== selectedFiles.length && <span className="text-xs text-muted">{removable.length ? "Protected files stay in place; review the exact list before moving." : selectedFiles[0] ? removalReason(selectedFiles[0].path) : "No eligible files."}</span>}
        <Button size="sm" variant="ghost" aria-label="Clear output selection" onClick={deselect}><Icon name="close" width={15} height={15} /></Button>
      </div>
    </div>}
    {shown.length ? <>{sections.map(section => section.cards.length > 0 && <section key={section.id} className="fd-output-section" aria-label={section.label}><header><h3>{section.label}</h3><span>{section.cards.length} {section.cards.length === 1 ? "output" : "outputs"}</span></header><div className={section.id === "media" ? "fd-output-grid" : "fd-output-document-list"}>{section.cards.map(group => { const file = group.files.find(file => file.path === chosenFormats[group.key]) ?? group.primary; const concern = group.files.find(file => sourceInfo(file.path).warning); return (<div key={group.key} className="fd-output-card" data-path={file.path} data-selected={group.files.every(file => selectedPaths.includes(file.path))}><label className="fd-output-checkbox-hit"><input className="fd-output-checkbox" data-path={file.path} type="checkbox" aria-label={`Select ${file.sourceName ? `${file.sourceName} · ` : ""}${group.label}${group.files.length > 1 ? ` (${group.files.length} files)` : ""}`} checked={group.files.every(file => selectedPaths.includes(file.path))} onChange={() => { const paths = group.files.map(file => file.path); setSelectedPaths(previous => paths.every(path => previous.includes(path)) ? previous.filter(path => !paths.includes(path)) : [...new Set([...previous, ...paths])]); setError(null); }} /></label><button className="fd-output-open" aria-label={`${file.kind === "videos" ? "Play" : "Open"} ${file.sourceName ? `${file.sourceName} · ` : ""}${basename(file.path)}`} onClick={() => { if (file.kind === "manufacturing" && group.files.length > 1) { setFilter("manufacturing"); return; } if (file.kind === "images" || file.kind === "videos" || /\.(glb|stl|obj)$/i.test(file.path)) setPreview(file.path); else useUiStore.getState().openProjectFile(file.path); }}>
      <div className="fd-output-thumbnail">{concern && <span className="fd-output-warning"><Icon name="warning" width={14} height={14} />Needs review</span>}{file.kind === "images" ? <ProjectImage projectId={projectId} path={file.path} alt={basename(file.path)} /> : file.kind === "videos" ? <><ProjectVideo projectId={projectId} path={file.path} thumbnail /><span className="fd-output-video-play"><Icon name="play" width={22} height={22} /></span></> : <><Icon name={file.kind === "models" ? "cube" : "fileLayers"} width={58} height={58} /><span>{file.path.split(".").pop()?.toUpperCase()}</span></>}</div>
      <div className="fd-output-caption"><strong><Icon name={file.kind === "images" ? "image" : file.kind === "videos" ? "play" : file.kind === "models" ? "cube" : "fileLayers"} width={18} height={18} aria-hidden="true" /><span>{group.label}</span></strong>{file.sourceName && <span className="fd-output-source">{file.sourceName}</span>}<span>{formatFileSize(file.size)} · {group.time.basis === "exported" ? "Exported" : "File saved"} {group.time.ms ? new Date(group.time.value).toLocaleString() : "Time unavailable"}</span><small data-stale={sourceInfo(file.path).warning}>{sourceInfo(file.path).label}</small>{concern && concern.path !== file.path && <small data-stale="true">{basename(concern.path)}: {sourceInfo(concern.path).label}</small>}</div>
    </button>{group.files.length > 1 && <label className="fd-output-variants">{group.files.length} {file.kind === "videos" ? "formats" : "files"}<Select aria-label={`Format or file for ${group.label}`} value={file.path} onChange={event => setChosenFormats(previous => ({ ...previous, [group.key]: event.target.value }))}>{group.files.map(variant => <option key={variant.path} value={variant.path}>{basename(variant.path)}</option>)}</Select></label>}<div className="fd-output-card-actions"><CanvasToolButton icon="folderOpen" label={`Show ${basename(file.path)} in Files`} onClick={() => useUiStore.getState().openProjectFile(file.path)} /><CanvasToolButton icon="download" label={`Download ${basename(file.path)}`} disabled={downloading} onClick={() => void download([file])} /><CanvasToolButton icon="trash" label={eligibility(file.path)?.eligible && !deletionReview.projectActive && !deletionReview.isFetching ? `Move only ${basename(file.path)} to Trash` : `Cannot move ${basename(file.path)}: ${removalReason(file.path)}`} disabled={deletionReview.projectActive || deletionReview.isFetching || !eligibility(file.path)?.eligible} onClick={() => setTrash({ paths: [file.path] })} /></div></div>); })}</div></section>)}</> : <div className="fd-output-empty"><h3>{outputs.length ? "No outputs match these filters" : "Your outputs will appear here"}</h3><p>{outputs.length ? "Try another name or source, or clear the filters to see all saved outputs." : "Create images, a board model, a video or export files from the menu above."}</p></div>}
    {trash && <OutputTrashDialog projectId={projectId} paths={trash.paths} onClose={() => setTrash(null)} onChanged={paths => { setSelectedPaths(previous => previous.filter(path => !paths.includes(path))); if (preview && paths.includes(preview)) setPreview(null); void project.refetch(); void deletionReview.refetch(); }} />}
    <Dialog open={imageOutput} onClose={() => setImageOutput(false)} title="Render board image" className="fd-output-preview-dialog">{imageOutput && <BoardImageOutput projectId={projectId} onAsk={() => setImageOutput(false)} />}</Dialog>
    {visible && visible.kind !== "manufacturing" && <OutputPreviewDialog key={`${projectId}:${visible.path}`} projectId={projectId} output={{ ...visible, kind: visible.kind }} status={sourceInfo(visible.path).label} warning={sourceInfo(visible.path).warning} onClose={() => setPreview(null)} />}
  </div>;
}
