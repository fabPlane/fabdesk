import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { savedOutputs, useBoardModelRevision, usePcbPreviewRevision, useEnclosureSourceRevision, useCoreClient, useProject, useRunTool, type OutputKind } from "@fabdesk/client-core";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { basename } from "../util";
const ModelCanvas = lazy(() => import("./ModelCanvas"));
const FILTERS = [{ id: "all", label: "All" }, { id: "images", label: "Images" }, { id: "videos", label: "Videos" }, { id: "models", label: "Models" }, { id: "manufacturing", label: "Manufacturing" }] as const;

/** Saved files first; one selected output reveals its actions. Creation remains deliberate. */
export function OutputsLibrary({ projectId }: { projectId: string | null }) {
  const client = useCoreClient(), project = useProject(projectId), generate = useRunTool();
  const [filter, setFilter] = useState<OutputKind | "all">("all"), [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null), [downloading, setDownloading] = useState(false), [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null), library = useRef<HTMLDivElement>(null), actions = useRef<HTMLDivElement>(null);
  const [actionPosition, setActionPosition] = useState({ left: 12, top: 150, width: 640 });
  const outputs = savedOutputs(project.data?.files ?? []), active = outputs.find(file => file.path === selected), shown = outputs.filter(file => filter === "all" || file.kind === filter);
  const modelRevision = useBoardModelRevision(projectId, outputs.some(file => file.path === "renders/board.glb"));
  const pcbRevision = usePcbPreviewRevision(projectId, outputs.some(file => file.path === "renders/pcb.svg"));
  const enclosureRevision = useEnclosureSourceRevision(projectId, outputs.some(file => file.path === "exports/enclosure.stl"));
  const sourceInfo = (path: string) => {
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
      const rect = card.getBoundingClientRect(), width = Math.min(700, window.innerWidth - 32), height = actions.current.offsetHeight;
      setActionPosition({ width, left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), top: Math.max(145, Math.min(rect.top - height - 12, window.innerHeight - height - 24)) });
    };
    position();
    const observer = new ResizeObserver(position); if (actions.current) observer.observe(actions.current);
    window.addEventListener("resize", position); library.current?.addEventListener("scroll", position);
    const host = library.current;
    return () => { observer.disconnect(); window.removeEventListener("resize", position); host?.removeEventListener("scroll", position); };
  }, [selected]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && menu.current && !menu.current.contains(event.target)) menu.current.open = false; };
    document.addEventListener("pointerdown", dismiss); return () => document.removeEventListener("pointerdown", dismiss);
  }, []);
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
    if (menu.current) menu.current.open = false;
    if (!projectId) return;
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
      <div><h2>Project outputs</h2><p>Choose a saved file to preview or download. Create a new output when you need one.</p></div>
      <details ref={menu} className="fd-workspace-menu fd-output-create" onKeyDown={event => { if (event.key === "Escape" && menu.current) { menu.current.open = false; menu.current.querySelector("summary")?.focus(); } }}>
        <summary><Icon name="plus" width={16} height={16} />Create output</summary>
        <div className="fd-workspace-menu-content">
          <button disabled={generate.state.status === "running"} onClick={() => create("render")}>Render board images</button>
          <button disabled={generate.state.status === "running"} onClick={() => create("glb")}>Generate board model</button>
          <button onClick={() => create("video")}>Make video…</button>
          <button onClick={() => create("files")}>Export files…</button>
        </div>
      </details>
    </header>
    <div className="fd-output-filters" role="group" aria-label="Filter saved outputs">{FILTERS.map(item => <Button size="sm" key={item.id} aria-pressed={filter === item.id} onClick={() => { setFilter(item.id); setSelected(null); }}>{item.label}</Button>)}<span>{shown.length} saved file{shown.length === 1 ? "" : "s"}</span></div>
    {generate.state.status === "running" && <p role="status" className="fd-output-feedback"><Spinner />Creating output…</p>}
    {(error || generate.state.error) && <p role="alert" className="fd-output-feedback">{error || generate.state.error}</p>}
    {active && <div ref={actions} style={actionPosition} className="fd-output-selected" data-testid="output-actions">
      <div className="fd-output-action-bar"><strong title={active.path}>{basename(active.path)}</strong>
        {canPreview && <Button size="sm" onClick={() => setPreview(active.path)}>{active.kind === "videos" ? "Play" : "Preview"}</Button>}
        <Button size="sm" disabled={downloading} onClick={() => void download()}>{downloading ? "Downloading…" : "Download"}</Button>
        {active.path === "renders/board.glb" && <Button size="sm" disabled={generate.state.status === "running"} onClick={() => create("glb")}>Regenerate model</Button>}
        <Button size="sm" variant="ghost" onClick={() => useUiStore.getState().openProjectFile(active.path)}>Show file</Button>
        <Button size="sm" variant="ghost" onClick={deselect}>Deselect</Button>
      </div>
    </div>}
    {shown.length ? <div className="fd-output-grid">{shown.map(file => <button key={file.path} className="fd-output-card" data-path={file.path} aria-pressed={selected === file.path} onClick={() => { if (menu.current) menu.current.open = false; setSelected(file.path); setError(null); }}>
      <div className="fd-output-thumbnail">{file.kind === "images" ? <ProjectImage projectId={projectId} path={file.path} alt={basename(file.path)} /> : <><Icon name={file.kind === "videos" ? "play" : file.kind === "models" ? "cube" : "export"} width={58} height={58} /><span>{file.path.split(".").pop()?.toUpperCase()}</span></>}</div>
      <div className="fd-output-caption"><strong>{basename(file.path)}</strong><span>{(file.size / 1024).toFixed(0)} KB · Saved {new Date(file.mtime).toLocaleDateString()}</span><small data-stale={sourceInfo(file.path).warning}>{sourceInfo(file.path).label}</small></div>
    </button>)}</div> : <div className="fd-output-empty"><h3>{filter === "all" ? "Your outputs will appear here" : "No saved files in this category"}</h3><p>Create images, a board model, a video or export files from the menu above.</p></div>}
    <Dialog open={!!visible} onClose={() => setPreview(null)} title={visible ? basename(visible.path) : "Output preview"} className="fd-output-preview-dialog">
      {visible && (visible.kind === "images" ? <ProjectImage projectId={projectId} path={visible.path} className="max-h-[70vh] w-full object-contain" /> : visible.kind === "videos" ? <ProjectVideo projectId={projectId} path={visible.path} className="max-h-[70vh]" /> : <div className="fd-output-model-preview"><Suspense fallback={<Spinner />}><ModelCanvas projectId={projectId} path={visible.path} /></Suspense></div>)}
    </Dialog>
  </div>;
}
