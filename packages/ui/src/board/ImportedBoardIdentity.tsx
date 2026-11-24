import { importedBoardLabel, useProject } from "@fabdesk/client-core";
import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useUiStore } from "../stores/ui";
import { askAboutSurface } from "../chat/useAssistantSurface";

/** Main’s existing source menu shows import provenance or the active native repository path. */
export function ImportedBoardIdentity({ projectId, workingSource, sourceRevision }: { projectId: string; workingSource?: string | null; sourceRevision?: string }) {
  const project = useProject(projectId), imported = project.data?.manifest.importedBoard;

  const open = (path: string) => {
    if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().openProjectFile(path);
  };
  if (workingSource) return <WorkspaceMenu className="fd-imported-board-identity" label={<><Icon name="pcb" width={16} height={16} /><span className="flex min-w-0 flex-col text-left" title={workingSource}><span className="truncate">{workingSource.split("/").pop()}</span><span className="truncate text-[10px] text-muted">{workingSource.split("/").slice(-3, -1).join("/") || "."}</span></span><Icon name="chevronDown" width={14} height={14} /></>}>
    <div className="fd-imported-board-details"><strong>Working native source</strong><p>{workingSource}</p>{sourceRevision && <p>Saved source revision: {sourceRevision.slice(0, 12)}</p>}<p>Original repository source for previews, placement, routing, checks, exports and board comments. Saved changes refresh content; runtime compatibility and checks still apply.</p></div>
    <button onClick={() => open(workingSource)}><Icon name="folderOpen" width={16} height={16} />Show working source in Files</button>
  </WorkspaceMenu>;
  if (!imported) return null;
  return <WorkspaceMenu className="fd-imported-board-identity" label={<><Icon name="pcb" width={16} height={16} /><span title={imported.path}>{importedBoardLabel(imported.path)}</span><Icon name="chevronDown" width={14} height={14} /></>}>
    <div className="fd-imported-board-details"><strong>Imported board</strong><p>{imported.path}</p><p>Working source: board.kicad_pcb. This records the file selected during import; later edits may differ. Other repository versions are separate files.</p></div>
    <button onClick={() => open("board.kicad_pcb")}><Icon name="folderOpen" width={16} height={16} />Show working PCB in Files</button>
    {imported.path !== "board.kicad_pcb" && <button onClick={() => open(imported.path)}><Icon name="folderOpen" width={16} height={16} />Show imported file in Files</button>}
    <button onClick={() => askAboutSurface({ projectId, label: "Imported board identity", priority: 20, details: JSON.stringify({ importedBoard: imported, workingSource: "board.kicad_pcb", instruction: "The recorded path/hash identify the historical import selection, not current freshness or all repository boards. Inspect the working source before proposing edits; do not modify other repository versions." }) }, "Explain the selected imported board and how its working copy relates to the repository versions.")}><Icon name="sparkles" width={16} height={16} />Ask about this board</button>
  </WorkspaceMenu>;
}
