import { useState } from "react";
import { useProject, useProjectOrder } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { ProjectImage } from "../chat/ProjectImage";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";

/** The current canonical board, derived from project files; no inferred assembly membership. */
export function ProjectOverview() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const order = useProjectOrder(projectId);
  const [selected, setSelected] = useState(false);
  const ui = () => useUiStore.getState();
  if (!projectId) return <EmptyState title="Choose a project to see its overview" />;
  if (project.isError) return <LoadError title="Could not load project overview" onRetry={() => void project.refetch()} />;
  if (!project.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  const files = project.data.files;
  const pcb = files.find((file) => file.path === "board.kicad_pcb");
  const schematic = files.find((file) => file.path === "board.kicad_sch");
  const preview = ["renders/top.png", "renders/pcb-top.png", "renders/populated-top.png", "renders/release-top.png", "renders/pcb.svg"]
    .map((path) => files.find((file) => file.path === path)).find(Boolean);
  const issues = [...(order.data?.warnings ?? []), ...(order.data?.reasons ?? [])];
  const exports = files.filter((file) => file.path.startsWith("exports/") || file.path.startsWith("renders/"));
  return <div className="fd-project-overview" onKeyDown={(event) => { if (event.key === "Escape") setSelected(false); }}>
    <div className="fd-overview-heading"><span className="fd-overview-eyebrow">PROJECT OVERVIEW</span><h1>{project.data.name}</h1><p>Your board, source files and outputs in one place.</p></div>
    {(pcb || preview) ? <div className="fd-overview-board">
      {selected && <div className="fd-board-context-tools" aria-label="Board actions">
        <span><Icon name="pcb" width={17} height={17} />Board selected</span>
        <Button variant="ghost" size="sm" onClick={() => ui().setBoardTab("pcb")}><Icon name="compose" width={16} height={16} />Open PCB</Button>
        <Button variant="ghost" size="sm" onClick={() => ui().setBoardTab("schematic")}>Schematic</Button>
        <Button variant="ghost" size="sm" onClick={() => ui().setWorkspaceArea("mechanical")}>Enclosure</Button>
      </div>}
      <button className="fd-overview-preview" data-selected={selected} aria-pressed={selected} aria-label="Select main board to show tools" onClick={() => setSelected(!selected)} onDoubleClick={() => ui().setBoardTab("pcb")}>
        {preview ? <ProjectImage projectId={projectId} path={preview.path} alt={`${project.data.name} board preview`} /> : <span><Icon name="pcb" width={64} height={64} /><span>Open the PCB to render its preview</span></span>}
      </button>
      <div className="fd-overview-board-caption"><strong>Main board</strong><span>{pcb ? "board.kicad_pcb" : "Rendered preview"}</span>{preview && <span>Saved preview</span>}<span>{schematic ? "Schematic available" : "No schematic source"}</span></div>
    </div> : <div className="fd-overview-empty"><Icon name="pcb" width={54} height={54} /><h2>Start with an idea or a sketch</h2><p>Your project is ready. Add a design or describe what you want to build.</p><Button onClick={() => { ui().setAssistantOpen(true); ui().focusComposer(); }}>Describe your board</Button><Button variant="ghost" onClick={() => ui().setSketchOpen(true)}>Add a sketch</Button></div>}
    <div className="fd-overview-facts">
      <button onClick={() => ui().setWorkspaceArea("files")}><Icon name="folder" width={18} height={18} /><strong>{files.length}</strong><span>project files</span></button>
      <button onClick={() => ui().setWorkspaceArea("outputs")}><Icon name="export" width={18} height={18} /><strong>{exports.length}</strong><span>outputs & previews</span></button>
      <button onClick={() => ui().setBoardTab("drc")}><Icon name={issues.length ? "warning" : "checklist"} width={18} height={18} /><strong>{order.isError ? "Unavailable" : issues.length ? "Needs review" : "Open checks"}</strong><span>{issues.length ? `${issues.length} readiness notes` : "DRC / ERC & readiness"}</span></button>
    </div>
  </div>;
}
