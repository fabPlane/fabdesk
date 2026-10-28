import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { assemblyModelNeedsReview, assemblyModelSummaryLabel, useAssemblyModelSummaries, useAssemblyPreviewRevisions, savedOutputs, useBoardSources, useBoardModelRevision, usePcbPreviewRevision, useEnclosureSourceRevision, useCoreClient, useProject, useRunTool, type OutputKind } from "@fabdesk/client-core";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { basename } from "../util";
const ModelCanvas = lazy(() => import("./ModelCanvas"));
const FILTERS = [{ id: "all", label: "All" }, { id: "images", label: "Images" }, { id: "videos", label: "Videos" }, { id: "models", label: "Models" }, { id: "manufacturing", label: "Manufacturing" }] as const;

/** Saved files first; one selected output reveals its actions. Creation remains deliberate. */
export function OutputsLibrary({ projectId }: { projectId: string | null }) {
  const client = useCoreClient(), project = useProject(projectId), generate = useRunTool();
  const [filter, setFilter] = useState<OutputKind | "all">("all"), [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null), [downloading, setDownloading] = useState(false), [error, setError] = useState<string | null>(null);
  const library = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const [actionPosition, setActionPosition] = useState({ left: 12, top: 150, maxWidth: 640 });
  const boardSources = useBoardSources(projectId), assembly = boardSources.data?.mode === "assembly";
  const memberPreviews = useAssemblyPreviewRevisions(projectId ?? "", assembly ? boardSources.data?.sources ?? [] : []);
  const memberModels = useAssemblyModelSummaries(projectId ?? "", assembly ? boardSources.data : undefined, !boardSources.isFetching && !boardSources.isError);
  const outputs = savedOutputs(project.data?.files ?? [], assembly ? boardSources.data?.sources : []), active = outputs.find(file => file.path === selected), shown = outputs.filter(file => filter === "all" || file.kind === filter);
  const modelRevision = useBoardModelRevision(projectId, !assembly && outputs.some(file => file.path === "renders/board.glb"));
  const pcbRevision = usePcbPreviewRevision(projectId, !assembly && outputs.some(file => file.path === "renders/pcb.svg"));
  const enclosureRevision = useEnclosureSourceRevision(projectId, !assembly && outputs.some(file => file.path === "exports/enclosure.stl"));
  const sourceInfo = (path: string) => {
    const member = outputs.find(file => file.path === path);
    if (member?.sourceId) {
      if (boardSources.isFetching) return { warning: false, label: "Checking board source…" };
      if (boardSources.isError) return { warning: false, label: "Board source check unavailable" };
      if (path.endsWith("/renders/board.glb") || path === "renders/board.glb") {
        const model = memberModels.data?.find(row => row.sourceId === member.sourceId);
        return { warning: !memberModels.isFetching && !memberModels.isError && assemblyModelNeedsReview(model), label: memberModels.isFetching ? "Checking model source…" : memberModels.isError ? "Model source check unavailable" : assemblyModelSummaryLabel(model) };
      }
      if (path.endsWith("/renders/pcb.svg") || path === "renders/pcb.svg") {
        const preview = memberPreviews.find(row => row.sourceId === member.sourceId);
        return { warning: !preview?.isFetching && !preview?.isError && ["source-changed", "artifact-changed"].includes(preview?.data ?? ""), label: preview?.isFetching ? "Checking preview source…" : preview?.isError ? "Preview source check unavailable" : preview?.data === "source-changed" ? "PCB changed · Review preview" : preview?.data === "artifact-changed" ? "Preview changed · Source unverified" : preview?.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified" };
      }
      return { warning: false, label: "Source not checked" };
    }
    if (path === "renders/board.glb") return { warning: ["source-changed", "artifact-changed"].includes(modelRevision.data ?? ""), label: modelRevision.isFetching ? "Checking model source…" : modelRevision.isError ? "Model source check unavailable" : modelRevision.data === "source-changed" ? "PCB changed · Review model" : modelRevision.data === "artifact-changed" ? "Model changed · Source unverified" : modelRevision.data === "source-unchanged" ? "PCB unchanged · Model dependencies unverified" : "Source unverified" };
    if (path === "renders/pcb.svg") return { warning: ["source-changed", "artifact-changed"].includes(pcbRevision.data ?? ""), label: pcbRevision.isFetching ? "Checking preview source…" : pcbRevision.isError ? "Preview source check unavailable" : pcbRevision.data === "source-changed" ? "PCB changed · Review preview" : pcbRevision.data === "artifact-changed" ? "Preview changed · Source unverified" : pcbRevision.data === "matches-source" ? "Preview matches saved PCB" : "Source unverified" };
    if (path === "exports/enclosure.stl") return { warning: enclosureRevision.data === "changed", label: enclosureRevision.isFetching ? "Checking case source…" : enclosureRevision.isError ? "Case source check unavailable" : enclosureRevision.data === "changed" ? "PCB changed · Review case" : enclosureRevision.data === "unchanged" ? "Case source unchanged · Fit unverified" : "Case source unverified" };
    return { warning: false, label: "Source unverified" };
  };
  const visible = outputs.find(file => file.path === preview);
  useEffect(() => { if (selected && !outputs.some(file => file.path === selected)) { setSelected(null); setPreview(null); } }, [project.data?.files, selected]);
  useLayoutEffect(() => {
    if (!selected) return;
    const card = [...(library.current?.querySelectorAll<HTMLButtonElement>(".fd-output-card") ?? [])].find(element => element.dataset.path === selected);
    card?.scrollIntoView({ block: "nearest" });
    const position = () => {
      if (!card || !actions.current) return;
      const rect = card.getBoundingClientRect(), width = Math.min(actions.current.offsetWidth, window.innerWidth - 32), height = actions.current.offsetHeight;
      setActionPosition({ maxWidth: window.innerWidth - 32, left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), top: Math.max(145, Math.min(rect.top - height - 12, window.innerHeight - height - 24)) });
    };
    position();
    const observer = new ResizeObserver(position);
    for (const element of [actions.current, card, library.current?.querySelector(".fd-output-library-heading"), library.current?.querySelector(".fd-output-toolbar")]) if (element) observer.observe(element);
    window.addEventListener("resize", position); library.current?.addEventListener("scroll", position);
    const host = library.current;
    return () => { observer.disconnect(); window.removeEventListener("resize", position); host?.removeEventListener("scroll", position); };
  }, [selected]);
  const deselect = () => {
    [...(library.current?.querySelectorAll<HTMLButtonElement>(".fd-output-card") ?? [])].find(card => card.dataset.path === selected)?.focus();
    setSelected(null);
  };
  const download = async () => {
    if (!active || !projectId || downloading) return;
    setDownloading(true); setError(null);
    try { const blob = await client.readFileBlob(projectId, active.path), url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = basename(active.path); link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000); }
    catch { setError("Could not download this output. Try again."); }
    finally { setDownloading(false); }
  };
  const create = (kind: "render" | "glb" | "video" | "files") => {
    if (!projectId || kind !== "files" && (boardSources.isPending || boardSources.isError)) return;
    if (assembly && kind === "glb") { useUiStore.getState().setWorkspaceTab("3d"); return; }
    if (assembly && kind === "render") return;
    if (kind === "video" || kind === "files") useUiStore.getState().setWorkspaceTab(kind === "video" ? "3d" : "files");
    else void generate.run(kind, { projectId });
  };
  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load outputs" onRetry={() => void project.refetch()} />;
  if (project.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const canPreview = active && (active.kind === "images" || active.kind === "videos" || /\.(glb|stl|obj)$/i.test(active.path));
  return <div ref={library} className="fd-outputs-library" data-testid="outputs-library" onKeyDown={event => {
    if (event.key === "Escape" && selected) { event.stopPropagation(); deselect(); }
  }}>
    <header className="fd-output-library-heading">
      <div className="sr-only"><h2>Project outputs</h2><p>Saved images, videos, models and manufacturing files.</p></div>
      {outputs.some(file => sourceInfo(file.path).warning) && <Button className="fd-output-review" size="sm" variant="ghost" onClick={() => useUiStore.getState().setBoardTab("updates")}><Icon name="warning" width={16} height={16} />Review updates · {outputs.filter(file => sourceInfo(file.path).warning).length}</Button>}
    </header>
    <div className="fd-output-toolbar">
      <div className="fd-output-filters" role="group" aria-label="Filter saved outputs">{FILTERS.map(item => <Button size="sm" key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setSelected(null); }}>{item.label}</Button>)}</div>
      <WorkspaceMenu className="fd-output-create" label={<><span>Create output</span><Icon name="plus" width={16} height={16} /></>}>
        <button disabled={assembly || boardSources.isPending || boardSources.isError || generate.state.status === "running"} title={assembly ? "Use the selected board’s PCB preview; member image renders are not available here yet." : undefined} onClick={() => create("render")}>Render board images</button>
        <button disabled={boardSources.isPending || boardSources.isError || generate.state.status === "running"} onClick={() => create("glb")}>Generate board model</button>
        <button disabled={assembly || boardSources.isPending || boardSources.isError} title={assembly ? "Member video export is not available yet" : undefined} onClick={() => create("video")}>Make video…</button>
        <button onClick={() => create("files")}>Export files…</button>
      </WorkspaceMenu>
    </div>
    <p className="sr-only">{shown.length} saved file{shown.length === 1 ? "" : "s"}{filter !== "all" ? ` · ${FILTERS.find(item => item.id === filter)?.label}` : ""}</p>
    {generate.state.status === "running" && <p role="status" className="fd-output-feedback"><Spinner />Creating output…</p>}
    {(error || generate.state.error) && <p role="alert" className="fd-output-feedback">{error || generate.state.error}</p>}
    {active && <div ref={actions} style={actionPosition} className="fd-output-selected" data-testid="output-actions">
      <div className="fd-output-action-bar"><strong title={active.path}>{basename(active.path)}</strong>
        {canPreview && <Button size="sm" onClick={() => setPreview(active.path)}>{active.kind === "videos" ? "Play" : "Preview"}</Button>}
        <Button size="sm" disabled={downloading} onClick={() => void download()}>{downloading ? "Downloading…" : "Download"}</Button>
        {active.path === "renders/board.glb" && <Button size="sm" disabled={boardSources.isPending || boardSources.isError || generate.state.status === "running"} onClick={() => create("glb")}>Regenerate model</Button>}
        <WorkspaceMenu key={active.path} className={`fd-output-more ${actionPosition.top > 300 ? "fd-output-more-above" : ""}`} label={<span aria-label="More output actions"><Icon name="more" width={18} height={18} /></span>}>
          <button onClick={() => useUiStore.getState().openProjectFile(active.path)}>Show file</button>
          <div className="fd-menu-caption">{sourceInfo(active.path).label}</div>
        </WorkspaceMenu>
        <Button size="sm" variant="ghost" aria-label="Deselect output" onClick={deselect}><Icon name="close" width={15} height={15} /></Button>
      </div>
    </div>}
    {shown.length ? <div className="fd-output-grid">{shown.map(file => <button key={file.path} className="fd-output-card" data-path={file.path} aria-pressed={selected === file.path} onClick={() => { setSelected(file.path); setError(null); }}>
      <div className="fd-output-thumbnail">{sourceInfo(file.path).warning && <span className="fd-output-warning"><Icon name="warning" width={14} height={14} />Needs review</span>}{file.kind === "images" ? <ProjectImage projectId={projectId} path={file.path} alt={basename(file.path)} /> : <><Icon name={file.kind === "videos" ? "play" : file.kind === "models" ? "cube" : "export"} width={58} height={58} /><span>{file.path.split(".").pop()?.toUpperCase()}</span></>}</div>
      <div className="fd-output-caption"><strong>{basename(file.path)}</strong>{file.sourceName && <span className="fd-output-source">{file.sourceName}</span>}<span>{(file.size / 1024).toFixed(0)} KB · Saved {new Date(file.mtime).toLocaleDateString()}</span><small data-stale={sourceInfo(file.path).warning}>{sourceInfo(file.path).label}</small></div>
    </button>)}</div> : <div className="fd-output-empty"><h3>{filter === "all" ? "Your outputs will appear here" : "No saved files in this category"}</h3><p>Create images, a board model, a video or export files from the menu above.</p></div>}
    <Dialog open={!!visible} onClose={() => setPreview(null)} title={visible ? basename(visible.path) : "Output preview"} className="fd-output-preview-dialog">
      {visible && (visible.kind === "images" ? <ProjectImage projectId={projectId} path={visible.path} className="max-h-[70vh] w-full object-contain" /> : visible.kind === "videos" ? <ProjectVideo projectId={projectId} path={visible.path} className="max-h-[70vh]" /> : <div className="fd-output-model-preview"><Suspense fallback={<Spinner />}><ModelCanvas projectId={projectId} path={visible.path} /></Suspense></div>)}
    </Dialog>
  </div>;
}
