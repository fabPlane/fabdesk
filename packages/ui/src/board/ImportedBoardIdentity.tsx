import { importedBoardLabel, useProject } from "@fabdesk/client-core";
import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { useUiStore } from "../stores/ui";
import { askAboutSurface } from "../chat/useAssistantSurface";

/** The chosen repository file is provenance; board.kicad_pcb remains the editable source. */
export function ImportedBoardIdentity({ projectId }: { projectId: string }) {
  const project = useProject(projectId), imported = project.data?.manifest.importedBoard;
  if (!imported) return null;
  const open = (path: string) => {
    if (useUiStore.getState().activeProjectId === projectId) useUiStore.getState().openProjectFile(path);
  };
  return <WorkspaceMenu className="fd-imported-board-identity" label={<><Icon name="pcb" width={16} height={16} /><span title={imported.path}>{importedBoardLabel(imported.path)}</span><Icon name="chevronDown" width={14} height={14} /></>}>
    <div className="fd-imported-board-details"><strong>Imported board</strong><p>{imported.path}</p><p>Working source: board.kicad_pcb. This records the file selected during import; later edits may differ. Other repository versions are separate files.</p></div>
    <button onClick={() => open("board.kicad_pcb")}><Icon name="folderOpen" width={16} height={16} />Show working PCB in Files</button>
    {imported.path !== "board.kicad_pcb" && <button onClick={() => open(imported.path)}><Icon name="folderOpen" width={16} height={16} />Show imported file in Files</button>}
    <button onClick={() => askAboutSurface({ projectId, label: "Imported board identity", priority: 20, details: JSON.stringify({ importedBoard: imported, workingSource: "board.kicad_pcb", instruction: "The recorded path/hash identify the historical import selection, not current freshness or all repository boards. Inspect the working source before proposing edits; do not modify other repository versions." }) }, "Explain the selected imported board and how its working copy relates to the repository versions.")}><Icon name="sparkles" width={16} height={16} />Ask about this board</button>
  </WorkspaceMenu>;
}
