import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { overviewBoardImages } from "@fabdesk/client-core";
import { useOverviewImage } from "./useOverviewImage";
import { useEffect, useRef, useState } from "react";
import { CoreHttpError, savedOutputs, editableSketchPaths, projectSketchImagePaths, useBoardSources, useProject, useProjectOrder, usePcbPreviewRevision, useBoardModelRevision, useEnclosureSourceRevision, usePcbCheckRevision, useVideoInputRevision, videoInputsNeedReview } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { AssemblyOverview } from "./AssemblyOverview";
import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "./WorkspaceMenu";

/** Declared assembly membership takes priority over the legacy canonical root board. */
export function ProjectOverview({ boardPicker = false }: { boardPicker?: boolean } = {}) {
  const projectId = useUiStore(state => state.activeProjectId), project = useProject(projectId), sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="Choose a project to see its overview" />;
  if (sources.isError && !sources.data && !(sources.error instanceof CoreHttpError && sources.error.status === 404 && project.data && !project.data.files.some(file => file.path === "fabplane.assembly.json"))) return <LoadError title="Could not inspect project board sources" onRetry={() => { void sources.refetch(); void project.refetch(); }} />;
  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.data?.mode === "assembly") return <AssemblyOverview boardPicker={boardPicker} projectId={projectId} name={project.data?.name ?? "Project overview"} data={sources.data} checking={sources.isFetching} failed={sources.isError} onRetry={() => { void sources.refetch(); }} />;
  return <SingleBoardOverview key={projectId} />;
}

function SingleBoardOverview() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const order = useProjectOrder(projectId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectionTrigger = useRef<HTMLButtonElement>(null);
  const [chosenReference, setChosenReference] = useState<string | null>(null);
  const [readinessOpen, setReadinessOpen] = useState(false);
  const files = project.data?.files ?? [], has = (path: string) => files.some(file => file.path === path);
  const pcbMissing = !has("board.kicad_pcb");
  const pcbRevision = usePcbPreviewRevision(projectId, has("renders/pcb.svg"));
  const modelRevision = useBoardModelRevision(projectId, has("renders/board.glb"));
  const enclosureRevision = useEnclosureSourceRevision(projectId, has("enclosure.json"));
  const checkRevision = usePcbCheckRevision(projectId, has("reports/drc.json"));
  const videoPath = ["mp4", "webm", "gif"].map(extension => `exports/product-video.${extension}`).find(has);
  const videoRevision = useVideoInputRevision(projectId, videoPath);
  const updates = [
    ...(videoPath && !videoRevision.isFetching && !videoRevision.isError && videoInputsNeedReview(videoRevision.data) ? ["Product video"] : []),
    ...(has("renders/pcb.svg") && (pcbMissing || ["source-changed", "artifact-changed", "missing-source"].includes(pcbRevision.data ?? "")) ? ["PCB preview"] : []),
    ...(has("renders/board.glb") && (pcbMissing || ["source-changed", "artifact-changed", "missing-source"].includes(modelRevision.data ?? "")) ? ["3D model"] : []),
    ...(has("enclosure.json") && enclosureRevision.data === "changed" ? ["Enclosure"] : []),
    ...(has("reports/drc.json") && (pcbMissing || ["source-changed", "missing-source"].includes(checkRevision.data ?? "")) ? ["PCB checks"] : []),
    ...(has("reports/erc.json") && !order.isFetching && !order.isError && order.data?.checks.erc === "stale" ? ["Schematic checks"] : []),
  ];
  const ui = () => useUiStore.getState();
  const pcb = files.find((file) => file.path === "board.kicad_pcb");
  const schematic = files.find((file) => file.path === "board.kicad_sch");
  const designTab = pcb || !schematic ? "pcb" : "schematic";
  const designLabel = pcb ? "Main board" : schematic ? "Schematic design" : "Saved board preview";
  const imageCandidates = overviewBoardImages(files, { schematicOnly: designTab === "schematic" });
  const overviewImage = useOverviewImage(projectId ?? "", imageCandidates);
  const preview = overviewImage.candidate;
  const issues = [...(order.data?.warnings ?? []), ...(order.data?.reasons ?? [])];
  const outputs = savedOutputs(files);
  const references = projectSketchImagePaths(files);
  const reference = chosenReference && references.includes(chosenReference) ? chosenReference : references[0];
  const editableReference = !!reference && editableSketchPaths([{ path: reference }]).includes(reference);
  const referenceOnly = !pcb && !schematic && !preview && !!reference;
  // New native sources must not inherit a selection made on a different design/reference.
  // A refreshed drawing of the same native board keeps its contextual tools.
  const surfaceKey = pcb ? "native:board.kicad_pcb" : schematic ? "native:board.kicad_sch" : preview ? `preview:${preview.path}` : `reference:${reference ?? ""}`;
  const selected = selectedKey === surfaceKey;
  const assistantSurface = projectId ? { projectId, label: selected ? `Overview · ${designLabel}` : "Project overview", priority: 5, details: JSON.stringify({ nativePcb: pcb?.path, nativeSchematic: schematic?.path, selected: selected ? surfaceKey : null, reference: reference, imagePreview: preview?.path, sourceCheckPending: project.isFetching }) } : null;
  useAssistantSurface(assistantSurface);
  useEffect(() => { if (selectedKey !== null && selectedKey !== surfaceKey) setSelectedKey(null); }, [selectedKey, surfaceKey]);

  const previewStatus = designTab === "schematic" ? "Saved schematic preview · freshness unverified" : preview?.path !== "renders/pcb.svg" ? "Saved image · source unverified"
    : pcbMissing ? "PCB source missing · saved drawing" : pcbRevision.isFetching ? "Checking preview source…" : pcbRevision.isError ? "Preview source check unavailable"
    : pcbRevision.data === "missing-source" ? "PCB source missing · saved drawing" : pcbRevision.data === "source-changed" ? "PCB changed since preview" : pcbRevision.data === "artifact-changed" ? "Preview changed · source unverified"
    : pcbRevision.data === "matches-source" ? "Preview matches saved PCB" : "Saved preview · source unverified";
  if (!projectId) return <EmptyState title="Choose a project to see its overview" />;
  if (project.isError) return <LoadError title="Could not load project overview" onRetry={() => void project.refetch()} />;
  if (!project.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div className="fd-project-overview" onKeyDown={(event) => { if (event.key === "Escape" && selected && !event.defaultPrevented) {
    event.preventDefault(); event.stopPropagation(); setSelectedKey(null); requestAnimationFrame(() => selectionTrigger.current?.focus({ preventScroll: true }));
  } }}>
    <div className="fd-overview-heading"><h1 title={project.data.name}>Project overview</h1><p>{referenceOnly ? "Select a saved reference to continue your design." : designTab === "schematic" ? "Select your schematic to open its tools." : "Select your board to open its tools."}</p>
      {updates.length > 0 && <Button className="fd-overview-updates" size="sm" variant="ghost" title={`${updates.join(", ")} ${updates.length === 1 ? "has" : "have"} source or artifact changes. This covers tracked artifacts only; review before sharing or fabrication.`} onClick={() => ui().setBoardTab("updates")}><Icon name="warning" width={16} height={16} />Review updates · {updates.length}</Button>}
    </div>
    {(pcb || schematic || preview) ? <div className="fd-overview-board">
      <button ref={selectionTrigger} className="fd-overview-preview" data-selected={selected} aria-pressed={selected} aria-label={`Select ${designLabel.toLowerCase()} to show tools`} onClick={() => setSelectedKey(selected ? null : surfaceKey)} onDoubleClick={() => ui().setBoardTab(pcb || schematic ? designTab : "files")}>
        {overviewImage.url ? <img src={overviewImage.url} onError={overviewImage.onError} alt={`${project.data.name} ${preview?.kind === "top" ? "saved top render" : "saved board preview"}`} /> : <span><Icon name={designTab === "schematic" ? "compose" : "pcb"} width={64} height={64} /><span>{designTab === "schematic" ? "Open the schematic to create its preview" : "Open the PCB to render its preview"}</span></span>}
      </button>
      {selected && <div className="fd-board-context-tools" aria-label="Board actions">
        <span><Icon name={designTab === "schematic" ? "compose" : "pcb"} width={17} height={17} />{designLabel}</span>
        <Button variant="ghost" size="sm" onClick={() => ui().setBoardTab(pcb || schematic ? designTab : "files")}><Icon name={pcb || schematic ? "compose" : "folderOpen"} width={16} height={16} />{!pcb && !schematic ? "Open project files" : designTab === "schematic" ? "Open schematic" : "Open board"}</Button>
        <Button variant="ghost" size="sm" onClick={() => {
          if (assistantSurface) askAboutSurface(assistantSurface, "Review this design’s available saved schematic and PCB sources. Explain its purpose and any changes that need attention before proposing edits.");
        }}><Icon name="sparkles" width={16} height={16} />Ask</Button>
        <WorkspaceMenu label={<><span>More</span><Icon name="chevronDown" width={14} height={14} /></>}>
          <button onClick={() => ui().setBoardTab(designTab === "schematic" ? "pcb" : "schematic")}>{designTab === "schematic" ? "PCB" : "Schematic"}</button>
          <button onClick={() => ui().setBoardTab("3d")}>3D model</button>
          <button onClick={() => ui().setWorkspaceArea("mechanical")}>Enclosure</button>
          <button onClick={() => ui().setBoardTab("drc")}>Checks</button>
        </WorkspaceMenu>
      </div>}
      <div className="fd-overview-board-caption"><strong>{designLabel}</strong>{preview && <span>{previewStatus}</span>}<span>{schematic ? "Schematic available" : "No schematic source"}</span>{!pcb && <span>No saved PCB</span>}</div>
    </div> : reference ? <div className="fd-overview-board fd-overview-reference">
      <button ref={selectionTrigger} className="fd-overview-preview" data-selected={selected} aria-pressed={selected} aria-label="Select saved reference to show tools" onClick={() => setSelectedKey(selected ? null : surfaceKey)}><ProjectImage projectId={projectId} path={reference} alt="Saved project reference" /></button>
      {selected && <div className="fd-board-context-tools" aria-label="Reference actions"><span><Icon name="image" width={17} height={17} />Reference</span>
        <Button size="sm" variant="ghost" onClick={() => {
          const state = ui(); if (state.activeProjectId !== projectId) return;
          const key = state.activeThreadId ?? newChatDraftKey(projectId);
          if (!state.attachments[key]?.some(item => item.path === reference)) state.addAttachment(key, { path: reference, mime: /\.jpe?g$/i.test(reference) ? "image/jpeg" : "image/png", label: reference.slice("sketches/".length) });
          state.focusComposer();
        }}><Icon name="sparkles" width={16} height={16} />Use in conversation</Button>
        <Button size="sm" variant="ghost" onClick={() => ui().openProjectFile(reference)}><Icon name="folderOpen" width={16} height={16} />Open file</Button>
      </div>}
      <div className="fd-overview-board-caption"><strong>Design reference</strong><span>Saved image · No saved PCB</span>{references.length > 1 ? <label>Reference<select aria-label="Saved project reference" value={reference} onChange={event => { setChosenReference(event.target.value); setSelectedKey(null); }}>{references.map(path => <option key={path} value={path}>{path.slice("sketches/".length)}</option>)}</select></label> : <span>{reference.slice("sketches/".length)}</span>}<Button size="sm" variant="ghost" onClick={() => ui().setSketchOpen(true, "draw", editableReference ? reference : undefined)}>{editableReference ? "Open drawing copy" : "Draw or open a sketch"}</Button></div>
    </div> : <div className="fd-overview-empty"><Icon name="pcb" width={54} height={54} /><h2>Start with an idea or a sketch</h2><p>Your project is ready. Add a design or describe what you want to build.</p><Button onClick={() => { ui().setAssistantOpen(true); ui().focusComposer(); }}>Describe your board</Button><Button variant="ghost" onClick={() => ui().setSketchOpen(true)}>Add a sketch</Button></div>}
    <nav className="fd-overview-facts" aria-label="Project resources">
      <button onClick={() => ui().setBoardTab("files")}><Icon name="folder" width={18} height={18} /><strong>{files.length}</strong><span>project files</span></button>
      <button onClick={() => ui().setBoardTab("renders")}><Icon name="export" width={18} height={18} /><strong>{outputs.length}</strong><span>saved outputs</span></button>
      <button onClick={() => setReadinessOpen(true)}><Icon name={issues.length ? "warning" : "checklist"} width={18} height={18} /><strong>{order.isError ? "Unavailable" : issues.length ? "Needs review" : "Review readiness"}</strong><span>{order.isFetching ? "Checking readiness…" : issues.length ? `${issues.length} readiness notes` : "DRC / ERC & readiness"}</span></button>
    </nav>
    <Dialog open={readinessOpen} onClose={() => setReadinessOpen(false)} title="Readiness notes">
      <p className="mb-4 text-sm text-muted">{project.data.name} · Main board. These notes describe preparation still needed; they are not all reported design errors.</p>
      {order.isFetching ? <p role="status"><Spinner /> Checking current readiness…</p> : order.isError ? <LoadError title="Could not load readiness notes" onRetry={() => void order.refetch()} /> : <>
        <ol className="space-y-3" aria-label="Current readiness notes">{issues.map((note, index) => {
          const check = /\b(DRC|ERC)\b/i.test(note), exports = /gerbers?|fabrication zip|fab house/i.test(note);
          const action = /\bDRC\b/i.test(note) ? "Review PCB checks" : check ? "Review schematic checks" : exports ? "Open export files" : "Review source files";
          return <li key={`${index}:${note}`} className="rounded-xl border border-border p-4">
            <div className="mb-2 flex items-start gap-2"><Icon name="warning" className="mt-0.5 shrink-0 text-warning" /><p className="text-sm leading-6">{note}</p></div>
            <Button size="sm" onClick={() => { setReadinessOpen(false); if (exports && !check) { ui().setWorkspaceArea("outputs"); ui().setWorkspaceTab("files"); } else ui().setBoardTab(check ? "drc" : "files"); }}>{action}</Button>
          </li>;
        })}</ol>
        {issues.length === 0 && <p className="text-sm">No current readiness notes. Review saved checks and source coverage before fabrication; this is not a compatibility or fit certification.</p>}
        <div className="mt-4 flex flex-wrap justify-end gap-2"><Button variant="ghost" onClick={() => { askAboutSurface({ projectId, label: "Overview / Readiness notes", priority: 50, details: JSON.stringify({ notes: issues, checks: order.data?.checks }) }, "Explain these readiness notes in order of what I should do next. Distinguish checks not run from reported findings. Inspect saved sources before proposing changes."); setReadinessOpen(false); }}><Icon name="sparkles" />Ask about these notes</Button>{issues.length === 0 && <Button onClick={() => { setReadinessOpen(false); ui().setBoardTab("drc"); }}>Open checks</Button>}</div>
      </>}
    </Dialog>
  </div>;
}
