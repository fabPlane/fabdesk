import { useState } from "react";
import { CoreHttpError, savedOutputs, projectSketchImagePaths, useBoardSources, useProject, useProjectOrder, usePcbPreviewRevision, useBoardModelRevision, useEnclosureSourceRevision, usePcbCheckRevision } from "@fabdesk/client-core";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
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
  const [selected, setSelected] = useState(false);
  const [chosenReference, setChosenReference] = useState<string | null>(null);
  const files = project.data?.files ?? [], has = (path: string) => files.some(file => file.path === path);
  const pcbRevision = usePcbPreviewRevision(projectId, has("renders/pcb.svg"));
  const modelRevision = useBoardModelRevision(projectId, has("renders/board.glb"));
  const enclosureRevision = useEnclosureSourceRevision(projectId, has("enclosure.json"));
  const checkRevision = usePcbCheckRevision(projectId, has("reports/drc.json"));
  const updates = [
    ...(has("renders/pcb.svg") && ["source-changed", "artifact-changed"].includes(pcbRevision.data ?? "") ? ["PCB preview"] : []),
    ...(has("renders/board.glb") && ["source-changed", "artifact-changed"].includes(modelRevision.data ?? "") ? ["3D model"] : []),
    ...(has("enclosure.json") && enclosureRevision.data === "changed" ? ["Enclosure"] : []),
    ...(has("reports/drc.json") && checkRevision.data === "source-changed" ? ["PCB checks"] : []),
    ...(has("reports/erc.json") && !order.isFetching && !order.isError && order.data?.checks.erc === "stale" ? ["Schematic checks"] : []),
  ];
  const ui = () => useUiStore.getState();
  if (!projectId) return <EmptyState title="Choose a project to see its overview" />;
  if (project.isError) return <LoadError title="Could not load project overview" onRetry={() => void project.refetch()} />;
  if (!project.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const pcb = files.find((file) => file.path === "board.kicad_pcb");
  const schematic = files.find((file) => file.path === "board.kicad_sch");
  const designTab = pcb || !schematic ? "pcb" : "schematic";
  const designLabel = pcb ? "Main board" : schematic ? "Schematic design" : "Saved board preview";
  const previewPaths = designTab === "schematic" ? ["renders/schematic.svg"] : ["renders/top.png", "renders/pcb-top.png", "renders/populated-top.png", "renders/release-top.png", "renders/pcb.svg"];
  const preview = previewPaths.map((path) => files.find((file) => file.path === path)).find(Boolean);
  const issues = [...(order.data?.warnings ?? []), ...(order.data?.reasons ?? [])];
  const outputs = savedOutputs(files);
  const references = projectSketchImagePaths(files);
  const reference = chosenReference && references.includes(chosenReference) ? chosenReference : references[0];
  const referenceOnly = !pcb && !schematic && !preview && !!reference;
  const previewStatus = designTab === "schematic" ? "Saved schematic preview · freshness unverified" : preview?.path !== "renders/pcb.svg" ? "Saved image · source unverified"
    : pcbRevision.isFetching ? "Checking preview source…" : pcbRevision.isError ? "Preview source check unavailable"
    : pcbRevision.data === "source-changed" ? "PCB changed since preview" : pcbRevision.data === "artifact-changed" ? "Preview changed · source unverified"
    : pcbRevision.data === "matches-source" ? "Preview matches saved PCB" : "Saved preview · source unverified";
  return <div className="fd-project-overview" onKeyDown={(event) => { if (event.key === "Escape") setSelected(false); }}>
    <div className="fd-overview-heading"><h1 title={project.data.name}>Project overview</h1><p>{referenceOnly ? "Select a saved reference to continue your design." : designTab === "schematic" ? "Select your schematic to open its tools." : "Select your board to open its tools."}</p>
      {updates.length > 0 && <Button className="fd-overview-updates" size="sm" variant="ghost" title={`${updates.join(", ")} have source or artifact changes. This covers tracked artifacts only; review before sharing or fabrication.`} onClick={() => ui().setBoardTab("updates")}><Icon name="warning" width={16} height={16} />Review updates · {updates.length}</Button>}
    </div>
    {(pcb || schematic || preview) ? <div className="fd-overview-board">
      {selected && <div className="fd-board-context-tools" aria-label="Board actions">
        <span><Icon name={designTab === "schematic" ? "compose" : "pcb"} width={17} height={17} />{designLabel}</span>
        <Button variant="ghost" size="sm" onClick={() => ui().setBoardTab(designTab)}><Icon name="compose" width={16} height={16} />{designTab === "schematic" ? "Open schematic" : "Open board"}</Button>
        <Button variant="ghost" size="sm" onClick={() => {
          const state = ui(); if (state.activeProjectId !== projectId) return;
          const key = state.activeThreadId ?? newChatDraftKey(projectId), previous = state.drafts[key] ?? "";
          const prompt = "Review this design’s available saved schematic and PCB sources. Explain its purpose and any changes that need attention before proposing edits.";
          state.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt); state.focusComposer();
        }}><Icon name="sparkles" width={16} height={16} />Ask</Button>
        <WorkspaceMenu label={<><span>More</span><Icon name="chevronDown" width={14} height={14} /></>}>
          <button onClick={() => ui().setBoardTab(designTab === "schematic" ? "pcb" : "schematic")}>{designTab === "schematic" ? "PCB" : "Schematic"}</button>
          <button onClick={() => ui().setBoardTab("3d")}>3D model</button>
          <button onClick={() => ui().setWorkspaceArea("mechanical")}>Enclosure</button>
          <button onClick={() => ui().setBoardTab("drc")}>Checks</button>
        </WorkspaceMenu>
      </div>}
      <button className="fd-overview-preview" data-selected={selected} aria-pressed={selected} aria-label={`Select ${designLabel.toLowerCase()} to show tools`} onClick={() => setSelected(!selected)} onDoubleClick={() => ui().setBoardTab(designTab)}>
        {preview ? <ProjectImage projectId={projectId} path={preview.path} alt={`${project.data.name} ${designTab} preview`} /> : <span><Icon name={designTab === "schematic" ? "compose" : "pcb"} width={64} height={64} /><span>{designTab === "schematic" ? "Open the schematic to create its preview" : "Open the PCB to render its preview"}</span></span>}
      </button>
      <div className="fd-overview-board-caption"><strong>{designLabel}</strong>{preview && <span>{previewStatus}</span>}<span>{schematic ? "Schematic available" : "No schematic source"}</span>{!pcb && <span>No saved PCB</span>}</div>
    </div> : reference ? <div className="fd-overview-board fd-overview-reference">
      {selected && <div className="fd-board-context-tools" aria-label="Reference actions"><span><Icon name="image" width={17} height={17} />Reference</span>
        <Button size="sm" variant="ghost" onClick={() => {
          const state = ui(); if (state.activeProjectId !== projectId) return;
          const key = state.activeThreadId ?? newChatDraftKey(projectId);
          if (!state.attachments[key]?.some(item => item.path === reference)) state.addAttachment(key, { path: reference, mime: /\.jpe?g$/i.test(reference) ? "image/jpeg" : "image/png", label: reference.slice("sketches/".length) });
          state.focusComposer();
        }}><Icon name="sparkles" width={16} height={16} />Use in conversation</Button>
        <Button size="sm" variant="ghost" onClick={() => ui().openProjectFile(reference)}><Icon name="folderOpen" width={16} height={16} />Open file</Button>
      </div>}
      <button className="fd-overview-preview" data-selected={selected} aria-pressed={selected} aria-label="Select saved reference to show tools" onClick={() => setSelected(!selected)}><ProjectImage projectId={projectId} path={reference} alt="Saved project reference" /></button>
      <div className="fd-overview-board-caption"><strong>Design reference</strong><span>Saved image · No saved PCB</span>{references.length > 1 ? <label>Reference<select aria-label="Saved project reference" value={reference} onChange={event => { setChosenReference(event.target.value); setSelected(false); }}>{references.map(path => <option key={path} value={path}>{path.slice("sketches/".length)}</option>)}</select></label> : <span>{reference.slice("sketches/".length)}</span>}<Button size="sm" variant="ghost" onClick={() => ui().setSketchOpen(true)}>Draw or open a sketch</Button></div>
    </div> : <div className="fd-overview-empty"><Icon name="pcb" width={54} height={54} /><h2>Start with an idea or a sketch</h2><p>Your project is ready. Add a design or describe what you want to build.</p><Button onClick={() => { ui().setAssistantOpen(true); ui().focusComposer(); }}>Describe your board</Button><Button variant="ghost" onClick={() => ui().setSketchOpen(true)}>Add a sketch</Button></div>}
    <nav className="fd-overview-facts" aria-label="Project resources">
      <button onClick={() => ui().setWorkspaceArea("files")}><Icon name="folder" width={18} height={18} /><strong>{files.length}</strong><span>project files</span></button>
      <button onClick={() => ui().setWorkspaceArea("outputs")}><Icon name="export" width={18} height={18} /><strong>{outputs.length}</strong><span>saved outputs</span></button>
      <button onClick={() => ui().setBoardTab("drc")}><Icon name={issues.length ? "warning" : "checklist"} width={18} height={18} /><strong>{order.isError ? "Unavailable" : issues.length ? "Needs review" : "Open checks"}</strong><span>{issues.length ? `${issues.length} readiness notes` : "DRC / ERC & readiness"}</span></button>
    </nav>
  </div>;
}
