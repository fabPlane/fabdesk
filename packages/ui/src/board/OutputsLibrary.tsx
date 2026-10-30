import { useAssistantSurface } from "../chat/useAssistantSurface";
import { OutputPreviewDialog } from "./OutputPreviewDialog";
import { BoardImageOutput } from "./BoardImageOutput";
import { buildZip } from "@fabdesk/board-art";
import { readOutputSelection } from "@fabdesk/client-core";
import { videoInputLabel } from "./VideoSourceStatus";
import { filterSavedOutputs, outputLibrarySections, useVideoInputRevisions, videoInputsNeedReview } from "@fabdesk/client-core";
import { useEffect, useRef, useState } from "react";
import { assemblyModelNeedsReview, assemblyModelSummaryLabel, useAssemblyModelSummaries, useAssemblyPreviewRevisions, savedOutputs, useBoardSources, useBoardModelRevision, usePcbPreviewRevision, useEnclosureSourceRevision, useCoreClient, useProject, useRunTool, type OutputKind } from "@fabdesk/client-core";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { basename } from "../util";
import { formatFileSize } from "./file-explorer";
const FILTERS = [{ id: "all", label: "All" }, { id: "images", label: "Images" }, { id: "videos", label: "Videos" }, { id: "models", label: "Models" }, { id: "manufacturing", label: "Manufacturing" }] as const;

/** Open a preview directly; explicit checkboxes select files for single or batch download. */
export function OutputsLibrary({ projectId }: { projectId: string | null }) {
  const client = useCoreClient(), project = useProject(projectId), generate = useRunTool();
  const [filter, setFilter] = useState<OutputKind | "all">("all"), [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const selected = selectedPaths.length === 1 ? selectedPaths[0] ?? null : null;
  const selectAll = useRef<HTMLInputElement>(null);
  const [imageOutput, setImageOutput] = useState(false);
  const [query, setQuery] = useState(""), [sourceScope, setSourceScope] = useState("all");
  const search = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null), [downloading, setDownloading] = useState(false), [error, setError] = useState<string | null>(null);
  const library = useRef<HTMLDivElement>(null), manufacturingFilter = useRef<HTMLButtonElement>(null);
  const boardSources = useBoardSources(projectId), assembly = boardSources.data?.mode === "assembly";
  const sourceReady = !!boardSources.data && !boardSources.isFetching && !boardSources.isError;
  const hasPcb = project.data?.files.some(file => file.path === "board.kicad_pcb") ?? false;
  const rootGenerationReady = sourceReady && !assembly && hasPcb && !project.isFetching && !project.isError;
  const memberPreviews = useAssemblyPreviewRevisions(projectId ?? "", assembly ? boardSources.data?.sources ?? [] : []);
  const memberModels = useAssemblyModelSummaries(projectId ?? "", assembly ? boardSources.data : undefined, !boardSources.isFetching && !boardSources.isError);
  const outputs = savedOutputs(project.data?.files ?? [], assembly ? boardSources.data?.sources : []), active = outputs.find(file => file.path === selected), shown = filterSavedOutputs(outputs, { kind: filter, query, ...(sourceScope === "project" ? { sourceId: null } : sourceScope.startsWith("source:") ? { sourceId: sourceScope.slice(7) } : {}) });
  const sections = outputLibrarySections(shown, filter === "all");
  const selectedFiles = shown.filter(file => selectedPaths.includes(file.path));
  const allSelected = shown.length > 0 && selectedFiles.length === shown.length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedFiles.length > 0 && !allSelected; }, [selectedFiles.length, allSelected]);
  const modelRevision = useBoardModelRevision(projectId, sourceReady && !assembly && outputs.some(file => file.path === "renders/board.glb"));
  const pcbRevision = usePcbPreviewRevision(projectId, sourceReady && !assembly && outputs.some(file => file.path === "renders/pcb.svg"));
  const enclosureRevision = useEnclosureSourceRevision(projectId, sourceReady && !assembly && outputs.some(file => file.path === "exports/enclosure.stl"));
  const videoRevisions = useVideoInputRevisions(projectId, sourceReady ? outputs.filter(file => /(^|\/)exports\/product-video\.(mp4|webm|gif)$/i.test(file.path)).map(file => file.path) : []);
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
      return { warning: false, label: "Source not checked" };
    }
    if (assembly) return { warning: false, label: "Project output · Source unverified" };
    if (path === "renders/board.glb") return { warning: !hasPcb || ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(modelRevision.data ?? ""), label: modelRevision.isFetching ? "Checking model source…" : modelRevision.isError ? "Model source check unavailable" : !hasPcb || modelRevision.data === "missing-source" ? "PCB source missing · Saved output" : modelRevision.data === "missing-artifact" ? "Saved model file missing" : modelRevision.data === "source-changed" ? "PCB changed · Review model" : modelRevision.data === "artifact-changed" ? "Model changed · Source unverified" : modelRevision.data === "source-unchanged" ? "PCB unchanged · Model dependencies unverified" : "Source unverified" };
    if (path === "renders/pcb.svg") return { warning: !hasPcb || ["source-changed", "artifact-changed", "missing-source", "missing-artifact"].includes(pcbRevision.data ?? ""), label: pcbRevision.isFetching ? "Checking preview source…" : pcbRevision.isError ? "Preview source check unavailable" : !hasPcb || pcbRevision.data === "missing-source" ? "PCB source missing · Saved output" : pcbRevision.data === "missing-artifact" ? "Saved preview file missing" : pcbRevision.data === "source-changed" ? "PCB changed · Review preview" : pcbRevision.data === "artifact-changed" ? "Preview changed · Source unverified" : pcbRevision.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified" };
    if (path === "exports/enclosure.stl") return { warning: enclosureRevision.data === "changed", label: enclosureRevision.isFetching ? "Checking case source…" : enclosureRevision.isError ? "Case source check unavailable" : enclosureRevision.data === "changed" ? "PCB changed · Review case" : enclosureRevision.data === "unchanged" ? "Case source unchanged · Fit unverified" : "Case source unverified" };
    const video = videoRevisions.find(row => row.path === path);
    if (video) return { warning: !video.isFetching && !video.isError && videoInputsNeedReview(video.data), label: video.isFetching || video.isPending ? "Checking video inputs…" : video.isError ? "Video inputs could not be checked" : videoInputLabel(video.data) };
    return { warning: false, label: "Source unverified" };
  };
  const visible = outputs.find(file => file.path === preview);
  const assistantSurface = projectId ? { projectId, label: visible ? `Output preview · ${basename(visible.path)}` : "Outputs / Library", priority: visible ? 40 : 5, details: JSON.stringify({ view: "Saved output library", preview: visible ? { path: visible.path, sourceId: visible.sourceId, sourceName: visible.sourceName, status: sourceInfo(visible.path).label } : null, selected: selectedPaths.slice(0, 20), sourceFilter: sourceScope, kindFilter: filter }) } : null;
  useAssistantSurface(assistantSurface);
  useEffect(() => { const visible = new Set(shown.map(file => file.path)); setSelectedPaths(previous => { const next = previous.filter(path => visible.has(path)); return next.length === previous.length ? previous : next; }); }, [project.data?.files, query, filter, sourceScope]);
  const deselect = () => {
    [...(library.current?.querySelectorAll<HTMLInputElement>(".fd-output-checkbox") ?? [])].find(card => card.dataset.path === selectedPaths[0])?.focus();
    setSelectedPaths([]);
  };
  const download = async () => {
    if (!selectedFiles.length || !projectId || downloading) return;
    const captured = [...selectedFiles];
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
  const canPreview = active && (active.kind === "images" || active.kind === "videos" || /\.(glb|stl|obj)$/i.test(active.path));
  return <div ref={library} className="fd-outputs-library" data-testid="outputs-library" onKeyDown={event => {
    if (event.key === "Escape" && selectedPaths.length && !preview) { event.stopPropagation(); deselect(); }
  }}>
    <header className="fd-output-library-heading">
      <div><h2>Saved outputs</h2><p>Images, videos, models and manufacturing files from this project.</p></div>
      {outputs.some(file => sourceInfo(file.path).warning) && <Button className="fd-output-review" size="sm" variant="ghost" onClick={() => useUiStore.getState().setBoardTab("updates")}><Icon name="warning" width={16} height={16} />Review updates · {outputs.filter(file => sourceInfo(file.path).warning).length}</Button>}
      <WorkspaceMenu className="fd-output-create" label={<><span>Create output</span><Icon name="plus" width={16} height={16} /></>}>
        {!sourceReady && <div className="fd-menu-caption">{boardSources.isError ? "Board sources could not be checked." : "Checking board sources…"}</div>}
        {boardSources.isError && <button onClick={() => void boardSources.refetch()}>Retry source check</button>}
        {sourceReady && !assembly && !hasPcb && <><div className="fd-menu-caption">Add a saved PCB in Board to create images, models or videos.</div><button onClick={() => useUiStore.getState().setBoardTab("pcb")}>Open Board</button></>}
        <button disabled={!sourceReady || !assembly && !hasPcb || generate.state.status === "running"} onClick={() => create("render")}>Render board images</button>
        <button disabled={!sourceReady || !assembly && !rootGenerationReady || generate.state.status === "running"} title={!assembly && !hasPcb ? "Add a saved PCB first" : undefined} onClick={() => create("glb")}>{assembly ? "Review board models…" : "Generate board model"}</button>
        <button disabled={!sourceReady || !assembly && !hasPcb} onClick={() => create("video")}>Make video…</button>
        <button onClick={() => create("files")}>Export files…</button>
      </WorkspaceMenu>
    </header>
    <div className="fd-output-toolbar">
    <div className="fd-output-discovery" aria-label="Find saved outputs">
      <label className="fd-output-search"><Icon name="search" width={16} height={16} /><input ref={search} aria-label="Find saved outputs" placeholder="Find an output…" value={query} onChange={event => { setQuery(event.target.value); setSelectedPaths([]); setError(null); }} /></label>
      {assembly && <label className="fd-output-scope">Source<select aria-label="Filter output source" value={sourceScope} onChange={event => { setSourceScope(event.target.value); setSelectedPaths([]); setError(null); }}><option value="all">All sources</option><option value="project">Project outputs</option>{boardSources.data?.sources.map(row => <option key={row.source.id} value={`source:${row.source.id}`}>{row.source.name}</option>)}{sourceScope.startsWith("source:") && !boardSources.data?.sources.some(row => `source:${row.source.id}` === sourceScope) && <option value={sourceScope} disabled>Source unavailable</option>}</select></label>}
      <span role="status">{shown.length} of {outputs.length} saved files</span>
      {(query || sourceScope !== "all" || filter !== "all") && <Button size="sm" variant="ghost" onClick={() => { setQuery(""); setSourceScope("all"); setFilter("all"); setSelectedPaths([]); setError(null); search.current?.focus(); }}>Clear filters</Button>}
    </div>
      <div className="fd-output-filters" role="group" aria-label="Filter saved outputs">{FILTERS.map(item => <Button ref={item.id === "manufacturing" ? manufacturingFilter : undefined} size="sm" key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setSelectedPaths([]); }}>{item.label}</Button>)}</div>

    </div>
    {generate.state.status === "running" && <p role="status" className="fd-output-feedback"><Spinner />Creating output…</p>}
    {(error || generate.state.error) && <p role="alert" className="fd-output-feedback">{error || generate.state.error}</p>}
    {shown.length > 0 && <label className="fd-output-select-all"><input ref={selectAll} type="checkbox" checked={allSelected} aria-label="Select all matching outputs" onChange={() => setSelectedPaths(allSelected ? [] : shown.map(file => file.path))} />Select all {shown.length} {shown.length === 1 ? "file" : "files"}</label>}
    {selectedFiles.length > 0 && <div className="fd-output-selected" data-testid="output-actions">
      <div className="fd-output-action-bar"><span className="fd-output-selection-count">{selectedFiles.length} {selectedFiles.length === 1 ? "file" : "files"} selected</span>{active ? <strong title={active.path}>{basename(active.path)}{active.sourceName && <small> · {active.sourceName}</small>}</strong> : <strong>Download these files together as a ZIP</strong>}
        {canPreview && <Button size="sm" onClick={() => active && setPreview(active.path)}>{active?.kind === "videos" ? "Play" : "Preview"}</Button>}
        <Button size="sm" disabled={downloading} onClick={() => void download()}>{downloading ? "Preparing download…" : selectedFiles.length > 1 ? "Download ZIP" : "Download"}</Button>
        {active?.path === "renders/board.glb" && <Button size="sm" disabled={!rootGenerationReady || generate.state.status === "running"} onClick={() => create("glb")}>Regenerate model</Button>}
        {active && <WorkspaceMenu key={active.path} className="fd-output-more" label={<span aria-label="More output actions"><Icon name="more" width={18} height={18} /></span>}>
          <button onClick={() => useUiStore.getState().openProjectFile(active.path)}>Show file</button>
          <div className="fd-menu-caption">{sourceInfo(active.path).label}</div>
        </WorkspaceMenu>}
        <Button size="sm" variant="ghost" aria-label="Clear output selection" onClick={deselect}><Icon name="close" width={15} height={15} /></Button>
      </div>
    </div>}
    {shown.length ? <div className="fd-output-grid">{sections.cards.map(file => <div key={file.path} className="fd-output-card" data-path={file.path} data-selected={selectedPaths.includes(file.path)}><label className="fd-output-checkbox-hit"><input className="fd-output-checkbox" data-path={file.path} type="checkbox" aria-label={`Select ${file.sourceName ? `${file.sourceName} · ` : ""}${basename(file.path)}`} checked={selectedPaths.includes(file.path)} onChange={() => { setSelectedPaths(previous => previous.includes(file.path) ? previous.filter(path => path !== file.path) : [...previous, file.path]); setError(null); }} /></label><button className="fd-output-open" aria-label={`${file.kind === "videos" ? "Play" : "Open"} ${file.sourceName ? `${file.sourceName} · ` : ""}${basename(file.path)}`} onClick={() => { if (file.kind === "images" || file.kind === "videos" || /\.(glb|stl|obj)$/i.test(file.path)) setPreview(file.path); else useUiStore.getState().openProjectFile(file.path); }}>
      <div className="fd-output-thumbnail">{sourceInfo(file.path).warning && <span className="fd-output-warning"><Icon name="warning" width={14} height={14} />Needs review</span>}{file.kind === "images" ? <ProjectImage projectId={projectId} path={file.path} alt={basename(file.path)} /> : file.kind === "videos" ? <><ProjectVideo projectId={projectId} path={file.path} thumbnail /><span className="fd-output-video-play"><Icon name="play" width={22} height={22} /></span></> : <><Icon name={file.kind === "models" ? "cube" : "export"} width={58} height={58} /><span>{file.path.split(".").pop()?.toUpperCase()}</span></>}</div>
      <div className="fd-output-caption"><strong><Icon name={file.kind === "images" ? "image" : file.kind === "videos" ? "play" : file.kind === "models" ? "cube" : "export"} width={18} height={18} aria-hidden="true" /><span>{basename(file.path)}</span></strong>{file.sourceName && <span className="fd-output-source">{file.sourceName}</span>}<span>{formatFileSize(file.size)} · Saved {new Date(file.mtime).toLocaleDateString()}</span><small data-stale={sourceInfo(file.path).warning}>{sourceInfo(file.path).label}</small></div>
    </button></div>)}{sections.manufacturingFiles.length > 0 && <button className="fd-output-card" aria-label={`View ${sections.manufacturingFiles.length} individual manufacturing files`} onClick={() => {
      setFilter("manufacturing"); setSelectedPaths([]);
      requestAnimationFrame(() => { if (useUiStore.getState().activeProjectId === projectId) manufacturingFilter.current?.focus(); });
    }}>
      <div className="fd-output-thumbnail"><Icon name="folderOpen" width={58} height={58} /><span>{sections.manufacturingFiles.length} FILES</span></div>
      <div className="fd-output-caption"><strong>Manufacturing files</strong><span>Individual Gerber, drill and DXF files</span><small>View all {sections.manufacturingFiles.length} files · Source unverified</small></div>
    </button>}</div> : <div className="fd-output-empty"><h3>{outputs.length ? "No outputs match these filters" : "Your outputs will appear here"}</h3><p>{outputs.length ? "Try another name or path, choose a different source, or clear the filters." : "Create images, a board model, a video or export files from the menu above."}</p></div>}
    <Dialog open={imageOutput} onClose={() => setImageOutput(false)} title="Render board image" className="fd-output-preview-dialog">{imageOutput && <BoardImageOutput projectId={projectId} onAsk={() => setImageOutput(false)} />}</Dialog>
    {visible && visible.kind !== "manufacturing" && <OutputPreviewDialog key={`${projectId}:${visible.path}`} projectId={projectId} output={{ ...visible, kind: visible.kind }} status={sourceInfo(visible.path).label} warning={sourceInfo(visible.path).warning} onClose={() => setPreview(null)} />}
  </div>;
}
